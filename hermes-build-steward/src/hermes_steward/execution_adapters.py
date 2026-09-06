from __future__ import annotations

from typing import Any, Mapping, Protocol

from .execution_contracts import (
    ExecutionContractError,
    ExecutorProfile,
    NormalizedExecutionRequest,
    validate_execution_result,
)


class ProviderRunner(Protocol):
    def invoke(
        self, profile: ExecutorProfile, request: NormalizedExecutionRequest, workspace: str
    ) -> Mapping[str, Any]: ...


class ExecutionAdapter(Protocol):
    profile: ExecutorProfile

    def execute(self, request: NormalizedExecutionRequest, workspace: str) -> dict[str, Any]: ...


_FAILURE_MAP = {
    "provider_unavailable": "PROVIDER_UNAVAILABLE",
    "authentication": "PROVIDER_AUTHENTICATION",
    "rate_limit": "PROVIDER_RATE_LIMIT",
    "policy_denied": "POLICY_DENIED",
    "resource_limit": "RESOURCE_LIMIT",
    "timeout": "TIMEOUT",
    "cancelled": "CANCELLED",
}


class _BaseExecutionAdapter:
    provider: str

    def __init__(self, profile: ExecutorProfile, runner: ProviderRunner):
        if profile.provider != self.provider:
            raise ExecutionContractError(f"{self.provider} adapter requires its matching profile")
        self.profile = profile
        self._runner = runner

    def execute(self, request: NormalizedExecutionRequest, workspace: str) -> dict[str, Any]:
        if request.executor_profile_id != self.profile.profile_id or request.executor_profile_fingerprint != self.profile.fingerprint:
            raise ExecutionContractError("adapter profile does not match normalized request")
        raw = self._runner.invoke(self.profile, request, workspace)
        normalized = self._normalize_provider_result(raw, request)
        return validate_execution_result(normalized, request)

    def _common_result(
        self,
        request: NormalizedExecutionRequest,
        *,
        disposition: str,
        started_at: Any,
        completed_at: Any,
        commands: Any,
        tests: Any,
        changed_paths: Any,
        patch_digest: Any,
        evidence_references: Any,
        failure_type: Any = None,
    ) -> dict[str, Any]:
        failure = "NONE" if disposition == "EXECUTION_SUCCEEDED" else _FAILURE_MAP.get(failure_type, "INTERNAL_ERROR")
        return {
            "schemaVersion": "1.0",
            "disposition": disposition,
            "acceptanceDisposition": "NOT_EVALUATED",
            "taskId": request.task_id,
            "taskVersion": request.task_version,
            "taskFingerprint": request.task_fingerprint,
            "attemptId": request.attempt_id,
            "executorProfile": {
                "profileId": self.profile.profile_id,
                "profileFingerprint": self.profile.fingerprint,
                "provider": self.profile.provider,
            },
            "timestamps": {"startedAt": started_at, "completedAt": completed_at},
            "baseSha": request.base_sha,
            "changedPaths": changed_paths,
            "patchDigest": patch_digest,
            "commandsExecuted": commands,
            "testOutcomes": tests,
            "branch": None,
            "commitSha": None,
            "draftPr": None,
            "evidenceReferences": evidence_references,
            "failureClassification": failure,
            "provenance": {
                "runtimeName": self.profile.runtime_name,
                "runtimeVersion": self.profile.runtime_version,
                "model": self.profile.model,
                "launcherVersion": self.profile.launcher_version,
                "profileFingerprint": self.profile.fingerprint,
            },
            "auditProvenanceId": request.audit_provenance_id,
        }

    def _normalize_provider_result(
        self, raw: Mapping[str, Any], request: NormalizedExecutionRequest
    ) -> dict[str, Any]:
        raise NotImplementedError


class CodexExecutionAdapter(_BaseExecutionAdapter):
    provider = "codex"
    _DISPOSITIONS = {
        "completed": "EXECUTION_SUCCEEDED", "failed": "EXECUTION_FAILED",
        "blocked": "EXECUTION_BLOCKED", "cancelled": "EXECUTION_CANCELLED",
        "timed_out": "EXECUTION_TIMED_OUT",
    }

    def _normalize_provider_result(self, raw: Mapping[str, Any], request: NormalizedExecutionRequest) -> dict[str, Any]:
        if not isinstance(raw, Mapping) or raw.get("status") not in self._DISPOSITIONS:
            raise ExecutionContractError("malformed Codex execution result")
        return self._common_result(
            request, disposition=self._DISPOSITIONS[raw["status"]],
            started_at=raw.get("started_at"), completed_at=raw.get("completed_at"),
            commands=raw.get("commands"), tests=raw.get("tests"),
            changed_paths=raw.get("changed_paths"), patch_digest=raw.get("patch_digest"),
            evidence_references=raw.get("log_refs"), failure_type=raw.get("error_type"),
        )


class ClaudeCodeExecutionAdapter(_BaseExecutionAdapter):
    provider = "claude-code"
    _DISPOSITIONS = {
        "end_turn": "EXECUTION_SUCCEEDED", "error": "EXECUTION_FAILED",
        "blocked": "EXECUTION_BLOCKED", "cancelled": "EXECUTION_CANCELLED",
        "timeout": "EXECUTION_TIMED_OUT",
    }

    def _normalize_provider_result(self, raw: Mapping[str, Any], request: NormalizedExecutionRequest) -> dict[str, Any]:
        if not isinstance(raw, Mapping) or raw.get("stop_reason") not in self._DISPOSITIONS:
            raise ExecutionContractError("malformed Claude Code execution result")
        return self._common_result(
            request, disposition=self._DISPOSITIONS[raw["stop_reason"]],
            started_at=raw.get("startedAt"), completed_at=raw.get("completedAt"),
            commands=raw.get("commandsExecuted"), tests=raw.get("testOutcomes"),
            changed_paths=raw.get("changedPaths"), patch_digest=raw.get("patchDigest"),
            evidence_references=raw.get("evidenceReferences"), failure_type=raw.get("errorType"),
        )
