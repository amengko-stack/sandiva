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
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .contracts import canonical_json, fingerprint


class GatewayServiceDenied(PermissionError):
    pass


@dataclass(frozen=True)
class GatewayPolicy:
    schema_version: str
    profile_id: str
    profile_fingerprint: str
    provider: str
    model: str
    upstream_scheme: str
    upstream_host: str
    upstream_port: int
    upstream_paths: tuple[str, ...]
    http_method: str
    max_request_bytes: int
    max_response_bytes: int
    timeout_seconds: int
    session_ttl_seconds: int
    max_requests_per_session: int
    implementation_digest: str
    network_policy_fingerprint: str
    credential_mode: str

    _MANIFEST_FIELDS = frozenset({
        "schemaVersion", "profileId", "profileFingerprint", "provider", "model",
        "upstreamScheme", "upstreamHost", "upstreamPort", "upstreamPaths", "httpMethod",
        "maxRequestBytes", "maxResponseBytes", "timeoutSeconds", "sessionTtlSeconds",
        "maxRequestsPerSession", "implementationDigest", "networkPolicyFingerprint",
        "credentialMode", "gatewayPolicyFingerprint",
    })

    @classmethod
    def from_manifest(cls, manifest_key: str, raw: Mapping[str, Any]) -> "GatewayPolicy":
        if not isinstance(raw, Mapping) or set(raw) != cls._MANIFEST_FIELDS:
            raise ValueError("gateway policy manifest fields are invalid")
        value = dict(raw)
        if manifest_key != value["profileFingerprint"]:
            raise ValueError("gateway manifest key does not match the exact profile fingerprint")
        expected = cls.fingerprint_manifest(value)
        if value["gatewayPolicyFingerprint"] != expected:
            raise ValueError("gateway policy fingerprint does not match canonical policy")
        try:
            return cls(
                schema_version=value["schemaVersion"], profile_id=value["profileId"],
                profile_fingerprint=value["profileFingerprint"], provider=value["provider"],
                model=value["model"], upstream_scheme=value["upstreamScheme"],
                upstream_host=value["upstreamHost"], upstream_port=value["upstreamPort"],
                upstream_paths=tuple(value["upstreamPaths"]), http_method=value["httpMethod"],
                max_request_bytes=value["maxRequestBytes"], max_response_bytes=value["maxResponseBytes"],
                timeout_seconds=value["timeoutSeconds"], session_ttl_seconds=value["sessionTtlSeconds"],
                max_requests_per_session=value["maxRequestsPerSession"],
                implementation_digest=value["implementationDigest"],
                network_policy_fingerprint=value["networkPolicyFingerprint"],
                credential_mode=value["credentialMode"],
            )
        except TypeError as error:
            raise ValueError("gateway policy manifest values are invalid") from error

    @staticmethod
    def fingerprint_manifest(raw: Mapping[str, Any]) -> str:
        """Fingerprint closed enforcement fields before adding the separately checked profile binding.

        The profile fingerprint itself includes this digest. Excluding only that recursive binding
        field permits deterministic construction; startup independently requires the exact manifest
        key and observed ExecutorProfile fingerprint to equal profileFingerprint.
        """
        value = {
            key: raw[key] for key in (
                "schemaVersion", "profileId", "provider", "model", "upstreamScheme",
                "upstreamHost", "upstreamPort", "upstreamPaths", "httpMethod",
                "maxRequestBytes", "maxResponseBytes", "timeoutSeconds", "sessionTtlSeconds",
                "maxRequestsPerSession", "implementationDigest", "networkPolicyFingerprint",
                "credentialMode",
            )
        }
        return fingerprint(value)

    def __post_init__(self) -> None:
        if self.schema_version != "1.0":
            raise ValueError("gateway policy schema version is invalid")
        if self.provider not in {"codex", "claude-code"}:
            raise ValueError("gateway provider is invalid")
        if not self.model or not self.profile_id:
            raise ValueError("gateway fixed profile/model is required")
        for value in (self.profile_fingerprint, self.implementation_digest, self.network_policy_fingerprint):
            if not re.fullmatch(r"[0-9a-f]{64}", value):
                raise ValueError("gateway fingerprint is invalid")
        if self.http_method != "POST":
            raise ValueError("gateway HTTP method is invalid")
        if self.upstream_scheme not in {"https", "http"}:
            raise ValueError("gateway upstream scheme is invalid")
        if not isinstance(self.upstream_port, int) or isinstance(self.upstream_port, bool) or not 1 <= self.upstream_port <= 65535:
            raise ValueError("gateway upstream port is invalid")
        if not isinstance(self.upstream_paths, tuple) or not self.upstream_paths or len(set(self.upstream_paths)) != len(self.upstream_paths):
            raise ValueError("gateway upstream path set is invalid")
        if any(
            not isinstance(path, str) or not path.startswith("/") or "?" in path or "#" in path
            or ".." in path.split("/") or urlsplit(path).query or urlsplit(path).fragment
            for path in self.upstream_paths
        ):
            raise ValueError("gateway upstream path set is invalid")
        production = {
            "codex": ("api.openai.com", ("/v1/responses",)),
            "claude-code": ("api.anthropic.com", ("/v1/messages",)),
        }[self.provider]
        if self.credential_mode == "trusted-header-injection":
            if (self.upstream_scheme, self.upstream_host, self.upstream_port, self.upstream_paths) != (
                "https", production[0], 443, production[1]
            ):
                raise ValueError("gateway production upstream is not the approved provider route")
        elif self.credential_mode == "synthetic-emulator":
            if self.upstream_scheme != "http" or not self.upstream_host.endswith(".test.internal"):
                raise ValueError("gateway synthetic upstream is invalid")
        else:
            raise ValueError("gateway credential mode is invalid")
        for value, name, minimum in (
            (self.max_request_bytes, "request limit", 128),
            (self.max_response_bytes, "response limit", 64),
            (self.timeout_seconds, "timeout", 1),
            (self.session_ttl_seconds, "session TTL", 1),
            (self.max_requests_per_session, "session use limit", 1),
        ):
            if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
                raise ValueError(f"gateway {name} is invalid")

    def canonical_identity(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version, "profileId": self.profile_id,
            "profileFingerprint": self.profile_fingerprint, "provider": self.provider,
            "model": self.model, "upstreamScheme": self.upstream_scheme,
            "upstreamHost": self.upstream_host, "upstreamPort": self.upstream_port,
            "upstreamPaths": list(self.upstream_paths), "httpMethod": self.http_method,
            "maxRequestBytes": self.max_request_bytes, "maxResponseBytes": self.max_response_bytes,
            "timeoutSeconds": self.timeout_seconds, "sessionTtlSeconds": self.session_ttl_seconds,
            "maxRequestsPerSession": self.max_requests_per_session,
            "implementationDigest": self.implementation_digest,
            "networkPolicyFingerprint": self.network_policy_fingerprint,
            "credentialMode": self.credential_mode,
        }

    @property
    def policy_fingerprint(self) -> str:
        return self.fingerprint_manifest(self.canonical_identity())

    @property
    def upstream_url(self) -> str:
        port = "" if (self.upstream_scheme, self.upstream_port) in {("https", 443), ("http", 80)} else f":{self.upstream_port}"
        return f"{self.upstream_scheme}://{self.upstream_host}{port}{self.upstream_paths[0]}"

    def assert_profile(self, profile: Any) -> None:
        if (
            self.profile_id != profile.profile_id or self.profile_fingerprint != profile.fingerprint
            or self.provider != profile.provider or self.model != profile.model
            or self.implementation_digest != profile.gateway_implementation_digest
            or self.policy_fingerprint != profile.gateway_policy_digest
        ):
            raise GatewayServiceDenied("gateway canonical policy does not match ExecutorProfile")

    def assert_runtime_mode(self, mode: str) -> None:
        if mode not in {"PRODUCTION", "CODE_QA"}:
            raise GatewayServiceDenied("gateway runtime mode is invalid")
        if mode == "PRODUCTION" and self.credential_mode != "trusted-header-injection":
            raise GatewayServiceDenied("gateway production mode rejects synthetic policy")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        del req, fp, code, msg, headers, newurl
        return None


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
    def __init__(self, policy: GatewayPolicy, credential_provider: Callable[[], str], *, opener: Callable[..., Any] | None = None):
        self.policy = policy
        self._credential_provider = credential_provider
        self._opener = opener or build_opener(_NoRedirect()).open

    @staticmethod
    def _read_bounded(stream: Any, limit: int) -> bytes:
        chunks: list[bytes] = []
        observed = 0
        while True:
            requested = min(65536, limit - observed + 1)
            chunk = stream.read(requested)
            if not isinstance(chunk, (bytes, bytearray)):
                raise GatewayServiceDenied("provider response rejected")
            if not chunk:
                break
            observed += len(chunk)
            if observed > limit:
                chunks.clear()
                raise GatewayServiceDenied("provider response exceeds gateway bound")
            chunks.append(bytes(chunk))
            # http.client.HTTPResponse.read(amt) fills amt unless EOF.  Treat a
            # short bounded read as EOF while retaining cumulative enforcement
            # for responses larger than the fixed read window.
            if len(chunk) < requested:
                break
        return b"".join(chunks)

    @staticmethod
    def _reject_reflection(raw: bytes, credential: str) -> None:
        secret = credential.encode("utf-8")
        reflected_headers = (b"Bearer " + secret, secret)
        if any(value and value in raw for value in reflected_headers):
            raise GatewayServiceDenied("provider response rejected")

    @classmethod
    def _reject_header_reflection(cls, headers: Any, credential: str) -> None:
        try:
            rendered = b"\n".join(
                str(key).encode("utf-8", "replace") + b":" + str(value).encode("utf-8", "replace")
                for key, value in headers.items()
            )
        except Exception as error:
            raise GatewayServiceDenied("provider response rejected") from error
        cls._reject_reflection(rendered, credential)

    @staticmethod
    def _require_provider_response(raw: bytes, content_type: str) -> str:
        media_type = content_type.split(";", 1)[0].strip().lower()
        if media_type == "application/json":
            try:
                value = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise GatewayServiceDenied("provider response rejected") from error
            if not isinstance(value, Mapping):
                raise GatewayServiceDenied("provider response rejected")
        elif media_type == "text/event-stream":
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError as error:
                raise GatewayServiceDenied("provider response rejected") from error
            if "\x00" in text or not any(line.startswith("data:") for line in text.splitlines()):
                raise GatewayServiceDenied("provider response rejected")
        else:
            raise GatewayServiceDenied("provider response content type is not approved")
        return media_type

    def forward(self, body: Mapping[str, Any], timeout_seconds: int | None = None) -> tuple[int, bytes, Mapping[str, str]]:
        if not isinstance(body, Mapping):
            raise GatewayServiceDenied("provider request must be an object")
        if any(key in body for key in ("url", "base_url", "endpoint", "upstream", "host")):
            raise GatewayServiceDenied("executor-selected upstream destination is denied")
        requested_model = body.get("model")
        if requested_model not in {None, self.policy.model}:
            raise GatewayServiceDenied("executor-selected model is denied")
        bounded = json.loads(json.dumps(dict(body)))
        bounded["model"] = self.policy.model
        encoded_request = canonical_json(bounded)
        if len(encoded_request) > self.policy.max_request_bytes:
            raise GatewayServiceDenied("provider request exceeds gateway bound")
        credential = self._credential_provider()
        if not credential:
            raise GatewayServiceDenied("provider credential is unavailable")
        if self.policy.provider == "codex":
            headers = {"Authorization": f"Bearer {credential}", "Content-Type": "application/json"}
        else:
            headers = {"x-api-key": credential, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
        request = Request(self.policy.upstream_url, data=encoded_request, headers=headers, method=self.policy.http_method)
        effective_timeout = self.policy.timeout_seconds if timeout_seconds is None else timeout_seconds
        if effective_timeout != self.policy.timeout_seconds:
            raise GatewayServiceDenied("gateway timeout cannot be caller selected")
        try:
            with self._opener(request, timeout=effective_timeout) as response:
                if response.status in range(300, 400) or getattr(response, "geturl", lambda: self.policy.upstream_url)() != self.policy.upstream_url:
                    raise GatewayServiceDenied("provider response rejected")
                self._reject_header_reflection(response.headers, credential)
                raw = self._read_bounded(response, self.policy.max_response_bytes)
                self._reject_reflection(raw, credential)
                media_type = self._require_provider_response(raw, response.headers.get("Content-Type", ""))
                return response.status, raw, {"Content-Type": media_type}
        except HTTPError as error:
            try:
                if error.code in range(300, 400):
                    raise GatewayServiceDenied("provider response rejected")
                self._reject_header_reflection(error.headers or {}, credential)
                raw = self._read_bounded(error, self.policy.max_response_bytes)
                self._reject_reflection(raw, credential)
                content_type = error.headers.get("Content-Type", "application/json") if error.headers is not None else "application/json"
                media_type = self._require_provider_response(raw, content_type)
                return error.code, raw, {"Content-Type": media_type}
            finally:
                error.close()
        except GatewayServiceDenied:
            raise
        except (TimeoutError, URLError, OSError) as error:
            raise GatewayServiceDenied("provider response transport failed") from error


class GatewayApplication:
    def __init__(self, policy: GatewayPolicy, codec: GatewaySessionCodec, proxy: BoundProviderProxy):
        self.policy, self.codec, self.proxy = policy, codec, proxy
        self._counts: dict[str, int] = {}
        self._peers: dict[str, str] = {}
        self._request_fingerprints: set[tuple[str, str]] = set()
        self._lock = threading.Lock()
        self.audit: list[dict[str, Any]] = []

    def health(self) -> dict[str, Any]:
        return {
            "status": "READY", "profileFingerprint": self.policy.profile_fingerprint,
            "policyFingerprint": self.policy.policy_fingerprint,
            "implementationDigest": self.policy.implementation_digest,
            "policy": self.policy.canonical_identity(),
        }

    def authorize(self, token: str, peer_identity: str = "trusted-local-test") -> dict[str, Any]:
        if not isinstance(peer_identity, str) or not peer_identity:
            raise GatewayServiceDenied("gateway peer identity is unavailable")
        claims = self.codec.verify(token, self.policy)
        identity = fingerprint(claims)
        with self._lock:
            observed_peer = self._peers.setdefault(identity, peer_identity)
            if observed_peer != peer_identity:
                raise GatewayServiceDenied("cross-executor gateway capability use is denied")
            count = self._counts.get(identity, 0) + 1
            if count > self.policy.max_requests_per_session:
                raise GatewayServiceDenied("gateway session request bound exhausted")
            self._counts[identity] = count
        return claims

    def execute(self, token: str, body: Mapping[str, Any], peer_identity: str = "trusted-local-test") -> tuple[int, bytes, Mapping[str, str]]:
        claims = self.authorize(token, peer_identity)
        session_identity = fingerprint(claims)
        request_identity = fingerprint(body)
        with self._lock:
            replay = (session_identity, request_identity)
            if replay in self._request_fingerprints:
                self.audit.append({
                    "taskFingerprint": claims["taskFingerprint"], "attemptId": claims["attemptId"],
                    "profileFingerprint": claims["profileFingerprint"], "requestFingerprint": request_identity,
                    "status": "DENIED", "classification": "REPLAY_DENIED",
                })
                raise GatewayServiceDenied("executor gateway request replay is denied")
            self._request_fingerprints.add(replay)
        audit = {
            "taskFingerprint": claims["taskFingerprint"], "attemptId": claims["attemptId"],
            "profileFingerprint": claims["profileFingerprint"], "requestFingerprint": request_identity,
        }
        try:
            result = self.proxy.forward(body)
        except GatewayServiceDenied:
            self.audit.append({**audit, "status": "DENIED", "classification": "POLICY_DENIED"})
            raise
        self.audit.append({**audit, "status": result[0]})
        return result


class GatewayControlPlane:
    """Trusted composition boundary used to attest and mint one bound executor session."""

    def __init__(self, application: GatewayApplication):
        self.application = application

    def prepare(self, profile: Any, request: Any) -> str:
        health = self.application.health()
        try:
            self.application.policy.assert_profile(profile)
        except GatewayServiceDenied:
            raise
        if (
            health.get("status") != "READY"
            or health.get("profileFingerprint") != profile.fingerprint
            or health.get("policyFingerprint") != profile.gateway_policy_digest
            or health.get("implementationDigest") != profile.gateway_implementation_digest
            or health.get("policy") != self.application.policy.canonical_identity()
        ):
            raise GatewayServiceDenied("gateway health/profile attestation mismatch")
        return self.application.codec.issue(
            task_fingerprint=request.task_fingerprint, attempt_id=request.attempt_id,
            profile_fingerprint=profile.fingerprint,
            ttl=self.application.policy.session_ttl_seconds,
        )


class MultiProfileGatewayApplication:
    """One reviewed gateway container serving exact preconfigured Codex and Claude profiles."""

    def __init__(self, applications: Mapping[str, GatewayApplication], codec: GatewaySessionCodec, *, runtime_mode: str):
        if len(applications) != 2 or {item.policy.provider for item in applications.values()} != {"codex", "claude-code"}:
            raise ValueError("gateway requires exact Codex and Claude profile applications")
        if any(key != item.policy.profile_fingerprint for key, item in applications.items()):
            raise ValueError("gateway profile map is malformed")
        for item in applications.values():
            item.policy.assert_runtime_mode(runtime_mode)
        self.applications = dict(applications)
        self.codec = codec
        self.runtime_mode = runtime_mode

    def health(self) -> dict[str, Any]:
        return {"status":"READY", "runtimeMode":self.runtime_mode, "profiles":{
            key:{
                "policyFingerprint":item.policy.policy_fingerprint,
                "implementationDigest":item.policy.implementation_digest,
                "policy":item.policy.canonical_identity(),
            }
            for key,item in sorted(self.applications.items())
        }}

    def issue(self, *, profile_fingerprint: str, task_fingerprint: str, attempt_id: str) -> str:
        application = self.applications.get(profile_fingerprint)
        if application is None: raise GatewayServiceDenied("gateway profile is not configured")
        return self.codec.issue(task_fingerprint=task_fingerprint,attempt_id=attempt_id,profile_fingerprint=profile_fingerprint,ttl=application.policy.session_ttl_seconds)

    def execute(self, path: str, token: str, body: Mapping[str, Any], peer_identity: str = "trusted-local-test") -> tuple[int, bytes, Mapping[str, str]]:
        selected = self.codec.untrusted_profile_fingerprint(token)
        application = self.applications.get(selected)
        if application is None: raise GatewayServiceDenied("gateway session profile is unknown")
        expected = "/v1/responses" if application.policy.provider == "codex" else "/v1/messages"
        if path != expected: raise GatewayServiceDenied("cross-provider gateway route denied")
        return application.execute(token, body, peer_identity)


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
                status, raw, headers = application.execute(token, body, self.client_address[0])
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
                status,raw,headers=application.execute(self.path,token,body,self.client_address[0]); self.send_response(status)
                for key,value in headers.items(): self.send_header(key,value)
                self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
            except (GatewayServiceDenied,json.JSONDecodeError,ValueError): self.send_error(403)
        def log_message(self, format: str, *args: object) -> None: return
    return Handler


def serve(application: GatewayApplication, host: str = "0.0.0.0", port: int = 8443) -> None:
    ThreadingHTTPServer((host, port), create_handler(application)).serve_forever()


def serve_multi(application: MultiProfileGatewayApplication, host: str = "0.0.0.0", port: int = 8443) -> None:
    ThreadingHTTPServer((host, port), create_multi_handler(application)).serve_forever()
