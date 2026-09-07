from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable, Mapping, Protocol
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .contracts import fingerprint
from .execution_contracts import ExecutorProfile, NormalizedExecutionRequest


class ExecutorGatewayDenied(PermissionError):
    pass


class TrustedProviderBackend(Protocol):
    def execute(
        self,
        profile: ExecutorProfile,
        request: NormalizedExecutionRequest,
        credential: str,
        timeout_seconds: int,
    ) -> Mapping[str, Any]: ...


class ProviderHTTPTransport(Protocol):
    def request(
        self, url: str, headers: Mapping[str, str], body: Mapping[str, Any], timeout_seconds: int
    ) -> tuple[int, Mapping[str, Any]]: ...


class UrlLibProviderHTTPTransport:
    def request(
        self, url: str, headers: Mapping[str, str], body: Mapping[str, Any], timeout_seconds: int
    ) -> tuple[int, Mapping[str, Any]]:
        request = Request(
            url, data=json.dumps(dict(body), separators=(",", ":")).encode("utf-8"),
            headers=dict(headers), method="POST",
        )
        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                raw = response.read()
                value = json.loads(raw)
                return response.status, value
        except HTTPError as error:
            raw = error.read()
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                value = {"error": "provider returned a non-JSON error"}
            return error.code, value


class CodexGatewayBackend:
    def __init__(self, *, transport: ProviderHTTPTransport | None = None):
        self.transport = transport or UrlLibProviderHTTPTransport()

    def execute(
        self, profile: ExecutorProfile, request: NormalizedExecutionRequest,
        credential: str, timeout_seconds: int,
    ) -> Mapping[str, Any]:
        if profile.provider != "codex":
            raise ExecutorGatewayDenied("Codex backend profile mismatch")
        status, value = self.transport.request(
            "https://api.openai.com/v1/responses",
            {"Authorization": f"Bearer {credential}", "Content-Type": "application/json"},
            {
                "model": profile.model,
                "input": json.dumps(request.as_dict(), sort_keys=True, separators=(",", ":")),
                "metadata": {"taskFingerprint": request.task_fingerprint, "attemptId": request.attempt_id},
                "max_output_tokens": 32768,
                "store": False,
            },
            timeout_seconds,
        )
        if status < 200 or status >= 300 or not isinstance(value, Mapping):
            raise ExecutorGatewayDenied(f"Codex provider returned HTTP {status}")
        return dict(value)


class ClaudeGatewayBackend:
    def __init__(self, *, transport: ProviderHTTPTransport | None = None):
        self.transport = transport or UrlLibProviderHTTPTransport()

    def execute(
        self, profile: ExecutorProfile, request: NormalizedExecutionRequest,
        credential: str, timeout_seconds: int,
    ) -> Mapping[str, Any]:
        if profile.provider != "claude-code":
            raise ExecutorGatewayDenied("Claude backend profile mismatch")
        status, value = self.transport.request(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": credential, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
            {
                "model": profile.model,
                "max_tokens": 32768,
                "messages": [{"role": "user", "content": json.dumps(request.as_dict(), sort_keys=True, separators=(",", ":"))}],
                "metadata": {"user_id": fingerprint({
                    "taskFingerprint": request.task_fingerprint,
                    "attemptId": request.attempt_id,
                })},
            },
            timeout_seconds,
        )
        if status < 200 or status >= 300 or not isinstance(value, Mapping):
            raise ExecutorGatewayDenied(f"Claude provider returned HTTP {status}")
        return dict(value)


def gateway_request(request: NormalizedExecutionRequest, profile: ExecutorProfile) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "operation": "EXECUTE_BOUND_ATTEMPT",
        "taskId": request.task_id,
        "taskFingerprint": request.task_fingerprint,
        "attemptId": request.attempt_id,
        "profileId": profile.profile_id,
        "profileFingerprint": profile.fingerprint,
    }


class TrustedExecutorGateway:
    """One bounded, profile-fixed provider invocation for one execution attempt.

    The instance is created on the trusted side from an already validated request.
    Executor input can select neither provider, model, credentials nor authority.
    """

    def __init__(
        self,
        profile: ExecutorProfile,
        request: NormalizedExecutionRequest,
        backend: TrustedProviderBackend,
        *,
        credential_provider: Callable[[], str],
        timeout_seconds: int,
        response_limit_bytes: int,
    ):
        if profile.profile_id != request.executor_profile_id or profile.fingerprint != request.executor_profile_fingerprint:
            raise ExecutorGatewayDenied("gateway profile does not match the trusted request")
        if not isinstance(timeout_seconds, int) or timeout_seconds < 1:
            raise ValueError("gateway timeout must be positive")
        if not isinstance(response_limit_bytes, int) or response_limit_bytes < 128:
            raise ValueError("gateway response limit is too small")
        self._profile = profile
        self._request = request
        self._backend = backend
        self._credential_provider = credential_provider
        self._timeout_seconds = timeout_seconds
        self._response_limit_bytes = response_limit_bytes
        self._used = False
        self._lock = threading.Lock()
        self.audit_records: list[dict[str, Any]] = []

    def execute(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        expected = gateway_request(self._request, self._profile)
        if not isinstance(envelope, Mapping) or set(envelope) != set(expected) or dict(envelope) != expected:
            raise ExecutorGatewayDenied("executor gateway request is not bound to the current task/profile/attempt")
        with self._lock:
            if self._used:
                raise ExecutorGatewayDenied("executor gateway replay is denied")
            self._used = True
        credential = self._credential_provider()
        if not credential:
            raise ExecutorGatewayDenied("provider credential is unavailable")
        started = time.monotonic()
        try:
            provider_result = self._backend.execute(
                self._profile, self._request, credential, self._timeout_seconds
            )
        except Exception as error:
            self.audit_records.append({
                "taskFingerprint": self._request.task_fingerprint,
                "attemptId": self._request.attempt_id,
                "profileFingerprint": self._profile.fingerprint,
                "requestFingerprint": fingerprint(expected),
                "outcome": "PROVIDER_FAILURE",
            })
            raise ExecutorGatewayDenied("trusted provider invocation failed") from error
        elapsed = time.monotonic() - started
        if elapsed > self._timeout_seconds:
            raise ExecutorGatewayDenied("trusted provider invocation exceeded its time bound")
        if not isinstance(provider_result, Mapping):
            raise ExecutorGatewayDenied("trusted provider response is malformed")
        response = {
            "schemaVersion": "1.0",
            "taskFingerprint": self._request.task_fingerprint,
            "attemptId": self._request.attempt_id,
            "profileFingerprint": self._profile.fingerprint,
            "providerResult": dict(provider_result),
        }
        encoded = json.dumps(response, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if credential.encode("utf-8") in encoded:
            self.audit_records.append({
                "taskFingerprint": self._request.task_fingerprint,
                "attemptId": self._request.attempt_id,
                "profileFingerprint": self._profile.fingerprint,
                "requestFingerprint": fingerprint(expected),
                "outcome": "CREDENTIAL_REFLECTION_DENIED",
            })
            raise ExecutorGatewayDenied("trusted provider response reflected credential material")
        if len(encoded) > self._response_limit_bytes:
            self.audit_records.append({
                "taskFingerprint": self._request.task_fingerprint,
                "attemptId": self._request.attempt_id,
                "profileFingerprint": self._profile.fingerprint,
                "requestFingerprint": fingerprint(expected),
                "outcome": "RESPONSE_SIZE_DENIED",
            })
            raise ExecutorGatewayDenied("trusted provider response exceeds its size bound")
        self.audit_records.append({
            "taskFingerprint": self._request.task_fingerprint,
            "attemptId": self._request.attempt_id,
            "profileFingerprint": self._profile.fingerprint,
            "requestFingerprint": fingerprint(expected),
            "responseFingerprint": fingerprint(response),
            "outcome": "RETURNED",
        })
        return response
