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
    def __init__(self, response_limit_bytes: int = 1024 * 1024):
        if not isinstance(response_limit_bytes, int) or response_limit_bytes < 64:
            raise ValueError("provider response limit is invalid")
        self.response_limit_bytes = response_limit_bytes

    def _read_bounded(self, stream: Any) -> bytes:
        raw = stream.read(self.response_limit_bytes + 1)
        if len(raw) > self.response_limit_bytes:
            raise ExecutorGatewayDenied("provider response exceeds its size bound")
        return raw

    def request(
        self, url: str, headers: Mapping[str, str], body: Mapping[str, Any], timeout_seconds: int
    ) -> tuple[int, Mapping[str, Any]]:
        request = Request(
            url, data=json.dumps(dict(body), separators=(",", ":")).encode("utf-8"),
            headers=dict(headers), method="POST",
        )
        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                raw = self._read_bounded(response)
                try:
                    value = json.loads(raw)
                except json.JSONDecodeError as error:
                    raise ExecutorGatewayDenied("provider returned malformed JSON") from error
                return response.status, value
        except HTTPError as error:
            try:
                raw = self._read_bounded(error)
                try:
                    value = json.loads(raw)
                except json.JSONDecodeError:
                    value = {"error": "provider returned a non-JSON error"}
                return error.code, value
            finally:
                error.close()


class CodexGatewayBackend:
    def __init__(self, *, transport: ProviderHTTPTransport | None = None):
        self.transport = transport or UrlLibProviderHTTPTransport()

    def execute(
        self, profile: ExecutorProfile, request: NormalizedExecutionRequest,
        credential: str, timeout_seconds: int,
    ) -> Mapping[str, Any]:
        del profile, request, credential, timeout_seconds
        raise ExecutorGatewayDenied(
            "one-shot Codex API responses are not software-build executions; use the reviewed CLI proxy gateway"
        )


class ClaudeGatewayBackend:
    def __init__(self, *, transport: ProviderHTTPTransport | None = None):
        self.transport = transport or UrlLibProviderHTTPTransport()

    def execute(
        self, profile: ExecutorProfile, request: NormalizedExecutionRequest,
        credential: str, timeout_seconds: int,
    ) -> Mapping[str, Any]:
        del profile, request, credential, timeout_seconds
        raise ExecutorGatewayDenied(
            "one-shot Claude Messages responses are not software-build executions; use the reviewed CLI proxy gateway"
        )


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
