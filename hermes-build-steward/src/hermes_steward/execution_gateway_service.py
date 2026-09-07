from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .contracts import canonical_json, fingerprint


class GatewayServiceDenied(PermissionError):
    pass


@dataclass(frozen=True)
class GatewayPolicy:
    provider: str
    model: str
    profile_id: str
    profile_fingerprint: str
    policy_fingerprint: str
    implementation_digest: str
    upstream_url: str
    max_request_bytes: int = 1024 * 1024
    max_response_bytes: int = 4 * 1024 * 1024
    max_requests_per_session: int = 128
    session_ttl_seconds: int = 3600

    def __post_init__(self) -> None:
        if self.provider not in {"codex", "claude-code"}:
            raise ValueError("gateway provider is invalid")
        if not self.model or not self.profile_id:
            raise ValueError("gateway fixed profile/model is required")
        for value in (self.profile_fingerprint, self.policy_fingerprint, self.implementation_digest):
            if not re.fullmatch(r"[0-9a-f]{64}", value):
                raise ValueError("gateway fingerprint is invalid")
        if not self.upstream_url.startswith("https://"):
            raise ValueError("gateway upstream must use HTTPS")


class GatewaySessionCodec:
    """Mint short-lived, attempt-bound capabilities without exposing provider credentials."""

    def __init__(self, signing_key: bytes, clock: Callable[[], float] = time.time):
        if len(signing_key) < 32:
            raise ValueError("gateway session signing key is invalid")
        self._key = signing_key
        self._clock = clock

    def issue(self, *, task_fingerprint: str, attempt_id: str, profile_fingerprint: str, ttl: int) -> str:
        claims = {
            "taskFingerprint": task_fingerprint,
            "attemptId": attempt_id,
            "profileFingerprint": profile_fingerprint,
            "issuedAt": int(self._clock()),
            "expiresAt": int(self._clock()) + ttl,
            "nonce": os.urandom(16).hex(),
        }
        payload = base64.urlsafe_b64encode(canonical_json(claims)).rstrip(b"=").decode("ascii")
        signature = hmac.new(self._key, payload.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{payload}.{signature}"

    def verify(self, token: str, policy: GatewayPolicy) -> dict[str, Any]:
        try:
            payload, signature = token.split(".", 1)
            expected = hmac.new(self._key, payload.encode("ascii"), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise GatewayServiceDenied("gateway session authentication failed")
            padded = payload + "=" * (-len(payload) % 4)
            claims = json.loads(base64.urlsafe_b64decode(padded))
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
            raise GatewayServiceDenied("gateway session authentication failed") from error
        if (
            not isinstance(claims, dict)
            or set(claims) != {"taskFingerprint", "attemptId", "profileFingerprint", "issuedAt", "expiresAt", "nonce"}
            or claims["profileFingerprint"] != policy.profile_fingerprint
            or not re.fullmatch(r"[0-9a-f]{64}", str(claims["taskFingerprint"]))
            or not isinstance(claims["attemptId"], str) or not claims["attemptId"]
            or not isinstance(claims["issuedAt"], int) or isinstance(claims["issuedAt"], bool)
            or not isinstance(claims["expiresAt"], int)
            or isinstance(claims["expiresAt"], bool)
            or claims["expiresAt"] < claims["issuedAt"]
            or claims["expiresAt"] < int(self._clock())
            or not re.fullmatch(r"[0-9a-f]{32}", str(claims["nonce"]))
        ):
            raise GatewayServiceDenied("gateway session is expired or cross-profile")
        return claims

    @staticmethod
    def untrusted_profile_fingerprint(token: str) -> str:
        try:
            payload = token.split(".", 1)[0]
            padded = payload + "=" * (-len(payload) % 4)
            value = json.loads(base64.urlsafe_b64decode(padded))
            result = value["profileFingerprint"]
        except (ValueError, KeyError, json.JSONDecodeError, UnicodeDecodeError) as error:
            raise GatewayServiceDenied("gateway session authentication failed") from error
        if not isinstance(result, str):
            raise GatewayServiceDenied("gateway session authentication failed")
        return result


class BoundProviderProxy:
    def __init__(self, policy: GatewayPolicy, credential_provider: Callable[[], str]):
        self.policy = policy
        self._credential_provider = credential_provider

    @staticmethod
    def _read_bounded(stream: Any, limit: int) -> bytes:
        value = stream.read(limit + 1)
        if len(value) > limit:
            raise GatewayServiceDenied("provider response exceeds gateway bound")
        return value

    def forward(self, body: Mapping[str, Any], timeout_seconds: int = 120) -> tuple[int, bytes, Mapping[str, str]]:
        if not isinstance(body, Mapping):
            raise GatewayServiceDenied("provider request must be an object")
        requested_model = body.get("model")
        if requested_model not in {None, self.policy.model}:
            raise GatewayServiceDenied("executor-selected model is denied")
        bounded = json.loads(json.dumps(dict(body)))
        bounded["model"] = self.policy.model
        credential = self._credential_provider()
        if not credential:
            raise GatewayServiceDenied("provider credential is unavailable")
        if self.policy.provider == "codex":
            headers = {"Authorization": f"Bearer {credential}", "Content-Type": "application/json"}
        else:
            headers = {"x-api-key": credential, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
        request = Request(self.policy.upstream_url, data=canonical_json(bounded), headers=headers, method="POST")
        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                raw = self._read_bounded(response, self.policy.max_response_bytes)
                return response.status, raw, {"Content-Type": response.headers.get("Content-Type", "application/json")}
        except HTTPError as error:
            try:
                raw = self._read_bounded(error, self.policy.max_response_bytes)
                return error.code, raw, {"Content-Type": "application/json"}
            finally:
                error.close()


class GatewayApplication:
    def __init__(self, policy: GatewayPolicy, codec: GatewaySessionCodec, proxy: BoundProviderProxy):
        self.policy, self.codec, self.proxy = policy, codec, proxy
        self._counts: dict[str, int] = {}
        self._request_fingerprints: set[tuple[str, str]] = set()
        self._lock = threading.Lock()
        self.audit: list[dict[str, Any]] = []

    def health(self) -> dict[str, Any]:
        return {
            "status": "READY", "profileFingerprint": self.policy.profile_fingerprint,
            "policyFingerprint": self.policy.policy_fingerprint,
            "implementationDigest": self.policy.implementation_digest,
        }

    def authorize(self, token: str) -> dict[str, Any]:
        claims = self.codec.verify(token, self.policy)
        identity = fingerprint(claims)
        with self._lock:
            count = self._counts.get(identity, 0) + 1
            if count > self.policy.max_requests_per_session:
                raise GatewayServiceDenied("gateway session request bound exhausted")
            self._counts[identity] = count
        return claims

    def execute(self, token: str, body: Mapping[str, Any]) -> tuple[int, bytes, Mapping[str, str]]:
        claims = self.authorize(token)
        session_identity = fingerprint(claims)
        request_identity = fingerprint(body)
        with self._lock:
            replay = (session_identity, request_identity)
            if replay in self._request_fingerprints:
                raise GatewayServiceDenied("executor gateway request replay is denied")
            self._request_fingerprints.add(replay)
        result = self.proxy.forward(body)
        self.audit.append({
            "taskFingerprint": claims["taskFingerprint"], "attemptId": claims["attemptId"],
            "profileFingerprint": claims["profileFingerprint"], "requestFingerprint": request_identity,
            "status": result[0],
        })
        return result


class GatewayControlPlane:
    """Trusted composition boundary used to attest and mint one bound executor session."""

    def __init__(self, application: GatewayApplication):
        self.application = application

    def prepare(self, profile: Any, request: Any) -> str:
        health = self.application.health()
        if health != {
            "status": "READY", "profileFingerprint": profile.fingerprint,
            "policyFingerprint": profile.gateway_policy_digest,
            "implementationDigest": profile.gateway_implementation_digest,
        }:
            raise GatewayServiceDenied("gateway health/profile attestation mismatch")
        return self.application.codec.issue(
            task_fingerprint=request.task_fingerprint, attempt_id=request.attempt_id,
            profile_fingerprint=profile.fingerprint,
            ttl=self.application.policy.session_ttl_seconds,
        )


class MultiProfileGatewayApplication:
    """One reviewed gateway container serving exact preconfigured Codex and Claude profiles."""

    def __init__(self, applications: Mapping[str, GatewayApplication], codec: GatewaySessionCodec):
        if len(applications) != 2 or {item.policy.provider for item in applications.values()} != {"codex", "claude-code"}:
            raise ValueError("gateway requires exact Codex and Claude profile applications")
        if any(key != item.policy.profile_fingerprint for key, item in applications.items()):
            raise ValueError("gateway profile map is malformed")
        self.applications = dict(applications)
        self.codec = codec

    def health(self) -> dict[str, Any]:
        return {"status":"READY", "profiles":{
            key:{"policyFingerprint":item.policy.policy_fingerprint,"implementationDigest":item.policy.implementation_digest}
            for key,item in sorted(self.applications.items())
        }}

    def issue(self, *, profile_fingerprint: str, task_fingerprint: str, attempt_id: str) -> str:
        application = self.applications.get(profile_fingerprint)
        if application is None: raise GatewayServiceDenied("gateway profile is not configured")
        return self.codec.issue(task_fingerprint=task_fingerprint,attempt_id=attempt_id,profile_fingerprint=profile_fingerprint,ttl=application.policy.session_ttl_seconds)

    def execute(self, path: str, token: str, body: Mapping[str, Any]) -> tuple[int, bytes, Mapping[str, str]]:
        selected = self.codec.untrusted_profile_fingerprint(token)
        application = self.applications.get(selected)
        if application is None: raise GatewayServiceDenied("gateway session profile is unknown")
        expected = "/v1/responses" if application.policy.provider == "codex" else "/v1/messages"
        if path != expected: raise GatewayServiceDenied("cross-provider gateway route denied")
        return application.execute(token, body)


def create_handler(application: GatewayApplication) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health": self.send_error(404); return
            raw = canonical_json(application.health()); self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

        def do_POST(self) -> None:
            expected_path = "/v1/responses" if application.policy.provider == "codex" else "/v1/messages"
            if self.path != expected_path: self.send_error(404); return
            try:
                length = int(self.headers.get("Content-Length", "-1"))
                if length < 0 or length > application.policy.max_request_bytes: raise GatewayServiceDenied("request size denied")
                body = json.loads(self.rfile.read(length))
                authorization = self.headers.get("Authorization", "")
                token = authorization[7:] if authorization.startswith("Bearer ") else self.headers.get("x-api-key", "")
                status, raw, headers = application.execute(token, body)
                self.send_response(status)
                for key, value in headers.items(): self.send_header(key, value)
                self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
            except (GatewayServiceDenied, json.JSONDecodeError, ValueError):
                self.send_error(403)

        def log_message(self, format: str, *args: object) -> None:
            return
    return Handler


def create_multi_handler(application: MultiProfileGatewayApplication) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/health": self.send_error(404); return
            raw=canonical_json(application.health()); self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
        def do_POST(self) -> None:
            try:
                length=int(self.headers.get("Content-Length","-1"))
                if length < 0 or length > 1024*1024: raise GatewayServiceDenied("request size denied")
                body=json.loads(self.rfile.read(length)); authorization=self.headers.get("Authorization","")
                token=authorization[7:] if authorization.startswith("Bearer ") else self.headers.get("x-api-key","")
                status,raw,headers=application.execute(self.path,token,body); self.send_response(status)
                for key,value in headers.items(): self.send_header(key,value)
                self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
            except (GatewayServiceDenied,json.JSONDecodeError,ValueError): self.send_error(403)
        def log_message(self, format: str, *args: object) -> None: return
    return Handler


def serve(application: GatewayApplication, host: str = "0.0.0.0", port: int = 8443) -> None:
    ThreadingHTTPServer((host, port), create_handler(application)).serve_forever()


def serve_multi(application: MultiProfileGatewayApplication, host: str = "0.0.0.0", port: int = 8443) -> None:
    ThreadingHTTPServer((host, port), create_multi_handler(application)).serve_forever()
