from __future__ import annotations

import json
import hashlib
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Mapping, Sequence

from .contracts import ContractValidationError, canonical_json, fingerprint, validate_repository_paths


class ExecutionContractError(ValueError):
    pass


_HASH = re.compile(r"^[0-9a-f]{64}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_PROFILE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$")
_IMAGE = re.compile(r"^(?:[a-z0-9][a-z0-9._/:~-]*@)?sha256:[0-9a-f]{64}$")
EXECUTION_DISPOSITIONS = frozenset({
    "EXECUTION_SUCCEEDED", "EXECUTION_FAILED", "EXECUTION_BLOCKED",
    "EXECUTION_CANCELLED", "EXECUTION_TIMED_OUT",
})
FAILURE_CLASSIFICATIONS = frozenset({
    "NONE", "PROVIDER_UNAVAILABLE", "PROVIDER_AUTHENTICATION", "PROVIDER_RATE_LIMIT",
    "MALFORMED_PROVIDER_RESULT", "POLICY_DENIED", "RESOURCE_LIMIT", "TIMEOUT",
    "CANCELLED", "WORKSPACE_FAILURE", "PUBLICATION_CONFLICT", "STALE_FENCE",
    "INTERNAL_ERROR",
})


def _nonempty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ExecutionContractError(f"{field} must be a non-empty string")
    return value


def _strings(value: Any, field: str, *, allow_empty: bool = True) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)) or (not allow_empty and not value):
        raise ExecutionContractError(f"{field} must be a list of strings")
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise ExecutionContractError(f"{field} must contain only non-empty strings")
    if len(value) != len(set(value)):
        raise ExecutionContractError(f"{field} must not contain duplicates")
    return tuple(value)


@dataclass(frozen=True)
class ExecutorProfile:
    profile_id: str
    provider: str
    runtime_name: str
    runtime_version: str
    model: str
    launcher_version: str
    executable_digest: str
    fixed_argv: tuple[str, ...]
    image: str
    credential_mode: str
    gateway_endpoint: str
    allowed_endpoints: tuple[str, ...]
    runtime_wrapper_digest: str
    gateway_implementation_digest: str
    gateway_policy_digest: str

    def __post_init__(self) -> None:
        if not _PROFILE_ID.fullmatch(self.profile_id):
            raise ExecutionContractError("profileId has an invalid format")
        if self.provider not in {"codex", "claude-code"}:
            raise ExecutionContractError("executor provider is not supported")
        for field in ("runtime_name", "runtime_version", "model", "launcher_version"):
            _nonempty(getattr(self, field), field)
        for field in (
            "executable_digest", "runtime_wrapper_digest",
            "gateway_implementation_digest", "gateway_policy_digest",
        ):
            if not _HASH.fullmatch(getattr(self, field)):
                raise ExecutionContractError(f"{field} must be a lowercase SHA-256 digest")
        if not self.fixed_argv or any(not isinstance(item, str) or not item for item in self.fixed_argv):
            raise ExecutionContractError("fixed_argv must be a non-empty argument vector")
        expected_launcher = "codex" if self.provider == "codex" else "claude"
        if self.fixed_argv[0] != expected_launcher:
            raise ExecutionContractError("fixed_argv must use the provider's approved launcher")
        if self.model not in self.fixed_argv:
            raise ExecutionContractError("fixed_argv must bind the fingerprinted model explicitly")
        if not _IMAGE.fullmatch(self.image):
            raise ExecutionContractError("executor image must be pinned by SHA-256 digest")
        if self.credential_mode != "trusted-egress-gateway":
            raise ExecutionContractError("executor credentials require trusted-egress-gateway mode")
        if not re.fullmatch(r"[a-z0-9.-]+:[1-9][0-9]{0,4}", self.gateway_endpoint):
            raise ExecutionContractError("gateway endpoint is invalid")
        gateway_host = self.gateway_endpoint.rsplit(":", 1)[0]
        if not gateway_host.endswith(".sandiva.internal"):
            raise ExecutionContractError("gateway endpoint must be a trusted Sandiva internal endpoint")
        _strings(self.allowed_endpoints, "allowed_endpoints", allow_empty=False)
        if self.gateway_endpoint not in self.allowed_endpoints:
            raise ExecutionContractError("gateway endpoint must be included in allowed_endpoints")

    def as_dict(self) -> dict[str, Any]:
        """Constructor-shaped copy, useful for trusted profile configuration."""
        return {
            "profile_id": self.profile_id,
            "provider": self.provider,
            "runtime_name": self.runtime_name,
            "runtime_version": self.runtime_version,
            "model": self.model,
            "launcher_version": self.launcher_version,
            "executable_digest": self.executable_digest,
            "fixed_argv": tuple(self.fixed_argv),
            "image": self.image,
            "credential_mode": self.credential_mode,
            "gateway_endpoint": self.gateway_endpoint,
            "allowed_endpoints": tuple(self.allowed_endpoints),
            "runtime_wrapper_digest": self.runtime_wrapper_digest,
            "gateway_implementation_digest": self.gateway_implementation_digest,
            "gateway_policy_digest": self.gateway_policy_digest,
        }

    def identity_dict(self) -> dict[str, Any]:
        return {
            "profileId": self.profile_id,
            "provider": self.provider,
            "runtimeName": self.runtime_name,
            "runtimeVersion": self.runtime_version,
            "model": self.model,
            "launcherVersion": self.launcher_version,
            "executableDigest": self.executable_digest,
            "fixedArgv": list(self.fixed_argv),
            "image": self.image,
            "credentialMode": self.credential_mode,
            "gatewayEndpoint": self.gateway_endpoint,
            "allowedEndpoints": list(self.allowed_endpoints),
            "runtimeWrapperDigest": self.runtime_wrapper_digest,
            "gatewayImplementationDigest": self.gateway_implementation_digest,
            "gatewayPolicyDigest": self.gateway_policy_digest,
        }

    @property
    def fingerprint(self) -> str:
        return fingerprint(self.identity_dict())


@dataclass(frozen=True)
class ObservedExecutorIdentity:
    image: str
    runtime_wrapper_digest: str
    executable_digest: str
    executable_version: str
    launcher_version: str
    model: str
    gateway_implementation_digest: str
    gateway_policy_digest: str

    @classmethod
    def from_profile(cls, profile: ExecutorProfile) -> "ObservedExecutorIdentity":
        return cls(
            image=profile.image,
            runtime_wrapper_digest=profile.runtime_wrapper_digest,
            executable_digest=profile.executable_digest,
            executable_version=profile.runtime_version,
            launcher_version=profile.launcher_version,
            model=profile.model,
            gateway_implementation_digest=profile.gateway_implementation_digest,
            gateway_policy_digest=profile.gateway_policy_digest,
        )

    def as_dict(self) -> dict[str, str]:
        return {
            "image": self.image,
            "runtimeWrapperDigest": self.runtime_wrapper_digest,
            "executableDigest": self.executable_digest,
            "executableVersion": self.executable_version,
            "launcherVersion": self.launcher_version,
            "model": self.model,
            "gatewayImplementationDigest": self.gateway_implementation_digest,
            "gatewayPolicyDigest": self.gateway_policy_digest,
        }

    def assert_matches(self, profile: ExecutorProfile) -> None:
        if self != ObservedExecutorIdentity.from_profile(profile):
            raise ExecutionContractError("observed executor identity does not match fingerprint-bound profile")


class ExecutorProfileRegistry:
    def __init__(self, profiles: Iterable[ExecutorProfile]):
        self._profiles: dict[str, ExecutorProfile] = {}
        for profile in profiles:
            if profile.profile_id in self._profiles:
                raise ExecutionContractError(f"duplicate executor profile: {profile.profile_id}")
            self._profiles[profile.profile_id] = profile

    def resolve(self, profile_id: str, expected_fingerprint: str) -> ExecutorProfile:
        profile = self._profiles.get(profile_id)
        if profile is None:
            raise ExecutionContractError(f"executor profile is not allowlisted: {profile_id}")
        if profile.fingerprint != expected_fingerprint:
            raise ExecutionContractError("executor profile fingerprint mismatch")
        return profile


@dataclass(frozen=True)
class ResolvedExecutionArtifacts:
    """Canonical bytes resolved by the trusted coordinator, never by the executor."""

    pm_instruction: bytes
    specification: bytes
    acceptance_contract: bytes

    def __post_init__(self) -> None:
        for field in ("pm_instruction", "specification", "acceptance_contract"):
            value = getattr(self, field)
            if not isinstance(value, bytes) or not value:
                raise ExecutionContractError(f"resolved {field} must be non-empty bytes")
            if len(value) > 512 * 1024:
                raise ExecutionContractError(f"resolved {field} exceeds the trusted content bound")

    @staticmethod
    def _text(value: bytes, field: str) -> str:
        try:
            text = value.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ExecutionContractError(f"resolved {field} must be UTF-8") from error
        if "\x00" in text:
            raise ExecutionContractError(f"resolved {field} contains a prohibited NUL")
        return text

    def verified_content(self, task: Mapping[str, Any]) -> dict[str, Any]:
        expected = {
            "pm_instruction": task["originatingPmInstructionFingerprint"],
            "specification": task["specificationHash"],
            "acceptance_contract": task["acceptanceContractHash"],
        }
        for field, digest in expected.items():
            if hashlib.sha256(getattr(self, field)).hexdigest() != digest:
                label = "PM instruction fingerprint" if field == "pm_instruction" else field.replace("_", " ") + " hash"
                raise ExecutionContractError(f"{label} does not match resolved canonical bytes")
        return {
            "pmInstruction": self._text(self.pm_instruction, "pm instruction"),
            "repository": task["repository"],
            "immutableBaseSha": task["baseRef"],
            "scope": list(task["scope"]),
            "acceptanceCriteria": list(task["acceptanceCriteria"]),
            "criterionEvidencePolicy": json.loads(json.dumps(task["criterionEvidencePolicy"])),
            "evaluationRequirements": list(task["evaluationRequirements"]),
            "qaRequirements": list(task["qaRequirements"]),
            "specification": self._text(self.specification, "specification"),
            "acceptanceContract": self._text(self.acceptance_contract, "acceptance contract"),
            "permittedRepositoryAreas": list(task["permittedRepositoryAreas"]),
            "prohibitedRepositoryAreas": list(task["prohibitedRepositoryAreas"]),
            "approvedCommands": list(task["executorPolicy"]["approvedCommands"]),
            "authorityReferences": {
                "permissionEnvelopeRef": task["permissionEnvelopeRef"],
                "networkPolicyRef": task["dispatchPolicy"]["networkPolicyRef"],
                "resourcePolicyRef": task["dispatchPolicy"]["resourcePolicyRef"],
                "publisherPolicyRef": task["dispatchPolicy"]["publisherPolicyRef"],
            },
        }


@dataclass(frozen=True)
class NormalizedExecutionRequest:
    task_id: str
    task_version: int
    task_fingerprint: str
    originating_pm_instruction_ref: str
    originating_pm_instruction_fingerprint: str
    specification_ref: str
    specification_version: str
    specification_hash: str
    acceptance_contract_ref: str
    acceptance_contract_version: str
    acceptance_contract_hash: str
    repository: str
    base_sha: str
    permitted_repository_areas: tuple[str, ...]
    prohibited_repository_areas: tuple[str, ...]
    approved_commands: tuple[str, ...]
    executor_profile_id: str
    executor_profile_fingerprint: str
    executor_provider: str
    attempt_id: str
    lease_id: str
    fencing_token: int
    retry_policy_json: str
    fallback_policy_json: str
    risk_level: str
    permission_envelope_ref: str
    network_policy_ref: str
    resource_policy_ref: str
    publisher_policy_ref: str
    audit_provenance_id: str
    execution_content_json: str
    execution_content_fingerprint: str
    observed_executor_identity_json: str
    fallback_context_json: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": "1.0",
            "taskId": self.task_id,
            "taskVersion": self.task_version,
            "taskFingerprint": self.task_fingerprint,
            "originatingPmInstructionRef": self.originating_pm_instruction_ref,
            "originatingPmInstructionFingerprint": self.originating_pm_instruction_fingerprint,
            "specificationRef": self.specification_ref,
            "specificationVersion": self.specification_version,
            "specificationHash": self.specification_hash,
            "acceptanceContractRef": self.acceptance_contract_ref,
            "acceptanceContractVersion": self.acceptance_contract_version,
            "acceptanceContractHash": self.acceptance_contract_hash,
            "repository": self.repository,
            "baseSha": self.base_sha,
            "permittedRepositoryAreas": list(self.permitted_repository_areas),
            "prohibitedRepositoryAreas": list(self.prohibited_repository_areas),
            "approvedCommands": list(self.approved_commands),
            "executorProfile": {
                "profileId": self.executor_profile_id,
                "profileFingerprint": self.executor_profile_fingerprint,
                "provider": self.executor_provider,
            },
            "attemptId": self.attempt_id,
            "lease": {"leaseId": self.lease_id, "fencingToken": self.fencing_token},
            "retryPolicy": json.loads(self.retry_policy_json),
            "fallbackPolicy": json.loads(self.fallback_policy_json),
            "riskLevel": self.risk_level,
            "permissionEnvelopeRef": self.permission_envelope_ref,
            "networkPolicyRef": self.network_policy_ref,
            "resourcePolicyRef": self.resource_policy_ref,
            "publisherPolicyRef": self.publisher_policy_ref,
            "auditProvenanceId": self.audit_provenance_id,
            "executionContent": json.loads(self.execution_content_json),
            "executionContentFingerprint": self.execution_content_fingerprint,
            "observedExecutorIdentity": json.loads(self.observed_executor_identity_json),
            "fallbackContext": json.loads(self.fallback_context_json),
        }


def normalize_execution_request(
    task: Mapping[str, Any],
    task_fingerprint: str,
    profile: ExecutorProfile,
    lease: Any,
    artifacts: ResolvedExecutionArtifacts,
    observed_identity: ObservedExecutorIdentity | None = None,
    fallback_context: Mapping[str, Any] | None = None,
) -> NormalizedExecutionRequest:
    if fingerprint(task) != task_fingerprint:
        raise ExecutionContractError("task fingerprint does not match validated task")
    policy = task.get("dispatchPolicy")
    if not isinstance(policy, Mapping):
        raise ExecutionContractError("validated dispatchPolicy is required")
    references = [policy["executorProfile"], *policy["permittedFallbackProfiles"]]
    selected = next((item for item in references if item["profileId"] == profile.profile_id), None)
    if selected is None:
        raise ExecutionContractError("executor profile is not authorized by the task")
    if selected["profileFingerprint"] != profile.fingerprint:
        raise ExecutionContractError("executor profile fingerprint does not match the task")
    attempt_id = _nonempty(getattr(lease, "attempt_id", None), "attemptId")
    lease_id = _nonempty(getattr(lease, "lease_id", None), "leaseId")
    fencing_token = getattr(lease, "fencing_token", None)
    if not isinstance(fencing_token, int) or isinstance(fencing_token, bool) or fencing_token < 1:
        raise ExecutionContractError("fencingToken must be a positive integer")
    if not isinstance(artifacts, ResolvedExecutionArtifacts):
        raise ExecutionContractError("trusted resolved execution artifacts are required")
    execution_content = artifacts.verified_content(task)
    observed = observed_identity or ObservedExecutorIdentity.from_profile(profile)
    observed.assert_matches(profile)
    context = {} if fallback_context is None else json.loads(json.dumps(dict(fallback_context)))
    if set(context) not in (set(), {"primaryAttemptId", "unavailableProfileId", "failureClassification"}):
        raise ExecutionContractError("fallback context fields are invalid")
    if context and context["failureClassification"] != "PROVIDER_UNAVAILABLE":
        raise ExecutionContractError("fallback context must record trusted primary unavailability")
    return NormalizedExecutionRequest(
        task_id=task["taskId"], task_version=task["taskVersion"], task_fingerprint=task_fingerprint,
        originating_pm_instruction_ref=task["originatingPmInstructionRef"],
        originating_pm_instruction_fingerprint=task["originatingPmInstructionFingerprint"],
        specification_ref=task["specificationRef"], specification_version=task["specificationVersion"],
        specification_hash=task["specificationHash"], acceptance_contract_ref=task["acceptanceContractRef"],
        acceptance_contract_version=task["acceptanceContractVersion"],
        acceptance_contract_hash=task["acceptanceContractHash"], repository=task["repository"],
        base_sha=task["baseRef"], permitted_repository_areas=tuple(task["permittedRepositoryAreas"]),
        prohibited_repository_areas=tuple(task["prohibitedRepositoryAreas"]),
        approved_commands=tuple(task["executorPolicy"]["approvedCommands"]),
        executor_profile_id=profile.profile_id, executor_profile_fingerprint=profile.fingerprint,
        executor_provider=profile.provider, attempt_id=attempt_id, lease_id=lease_id,
        fencing_token=fencing_token,
        retry_policy_json=canonical_json(task["retryPolicy"]).decode("ascii"), risk_level=task["riskLevel"],
        fallback_policy_json=canonical_json({
            "mode": policy["fallbackMode"],
            "noDowngrade": policy["noDowngrade"],
            "permittedProfiles": policy["permittedFallbackProfiles"],
        }).decode("ascii"),
        permission_envelope_ref=task["permissionEnvelopeRef"],
        network_policy_ref=policy["networkPolicyRef"],
        resource_policy_ref=policy["resourcePolicyRef"],
        publisher_policy_ref=policy["publisherPolicyRef"],
        audit_provenance_id=policy["auditProvenanceId"],
        execution_content_json=canonical_json(execution_content).decode("ascii"),
        execution_content_fingerprint=fingerprint(execution_content),
        observed_executor_identity_json=canonical_json(observed.as_dict()).decode("ascii"),
        fallback_context_json=canonical_json(context).decode("ascii"),
    )


_RESULT_FIELDS = {
    "schemaVersion", "disposition", "acceptanceDisposition", "taskId", "taskVersion",
    "taskFingerprint", "attemptId", "executorProfile", "timestamps", "baseSha",
    "changedPaths", "patchDigest", "commandsExecuted", "testOutcomes", "branch",
    "commitSha", "draftPr", "evidenceReferences", "failureClassification",
    "provenance", "auditProvenanceId",
}


def validate_execution_result(
    raw: Mapping[str, Any], request: NormalizedExecutionRequest, max_bytes: int = 65536,
    *, allow_trusted_publication: bool = False,
) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise ExecutionContractError("execution result must be an object")
    value = json.loads(json.dumps(dict(raw)))
    if len(canonical_json(value)) > max_bytes:
        raise ExecutionContractError("execution result exceeds the configured size limit")
    if set(value) != _RESULT_FIELDS:
        raise ExecutionContractError("execution result fields are invalid")
    if value["schemaVersion"] != "1.0" or value["acceptanceDisposition"] != "NOT_EVALUATED":
        raise ExecutionContractError("execution result cannot assert acceptance")
    if value["disposition"] not in EXECUTION_DISPOSITIONS:
        raise ExecutionContractError("execution disposition is invalid")
    expected = request.as_dict()
    identity = {
        "taskId": expected["taskId"], "taskVersion": expected["taskVersion"],
        "taskFingerprint": expected["taskFingerprint"], "attemptId": expected["attemptId"],
        "baseSha": expected["baseSha"], "auditProvenanceId": expected["auditProvenanceId"],
    }
    for field, expected_value in identity.items():
        if value[field] != expected_value:
            raise ExecutionContractError(f"execution result {field} does not match trusted request")
    if value["executorProfile"] != expected["executorProfile"]:
        raise ExecutionContractError("execution result executorProfile does not match trusted request")
    timestamps = value["timestamps"]
    if not isinstance(timestamps, dict) or set(timestamps) != {"startedAt", "completedAt"}:
        raise ExecutionContractError("execution result timestamps are invalid")
    try:
        started = datetime.fromisoformat(timestamps["startedAt"].replace("Z", "+00:00"))
        completed = datetime.fromisoformat(timestamps["completedAt"].replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError) as error:
        raise ExecutionContractError("execution result timestamps are invalid") from error
    if started.tzinfo is None or completed.tzinfo is None or completed < started:
        raise ExecutionContractError("execution result timestamps are invalid")
    for field in ("changedPaths", "commandsExecuted", "evidenceReferences"):
        _strings(value[field], field)
    try:
        validate_repository_paths(
            {
                "permittedRepositoryAreas": list(request.permitted_repository_areas),
                "prohibitedRepositoryAreas": list(request.prohibited_repository_areas),
            },
            value["changedPaths"],
        )
    except ContractValidationError as error:
        raise ExecutionContractError(f"execution result path authority violation: {error}") from error
    if not set(value["commandsExecuted"]).issubset(set(request.approved_commands)):
        raise ExecutionContractError("execution result reports an unauthorized command")
    patch_digest = value["patchDigest"]
    if patch_digest is not None and (not isinstance(patch_digest, str) or not _HASH.fullmatch(patch_digest)):
        raise ExecutionContractError("patchDigest is invalid")
    outcomes = value["testOutcomes"]
    if not isinstance(outcomes, list):
        raise ExecutionContractError("testOutcomes must be a list")
    for outcome in outcomes:
        if not isinstance(outcome, dict) or set(outcome) != {"name", "status", "command"}:
            raise ExecutionContractError("test outcome fields are invalid")
        _nonempty(outcome["name"], "test outcome name")
        if outcome["status"] not in {"PASS", "FAIL", "SKIPPED"}:
            raise ExecutionContractError("test outcome status is invalid")
        if outcome["command"] not in request.approved_commands:
            raise ExecutionContractError("test outcome command is unauthorized")
    branch, commit_sha, draft_pr = value["branch"], value["commitSha"], value["draftPr"]
    populated_publication = (branch is not None, commit_sha is not None, draft_pr is not None)
    if allow_trusted_publication:
        if value["disposition"] == "EXECUTION_SUCCEEDED" and not all(populated_publication):
            raise ExecutionContractError("trusted successful result requires complete publication identity")
    elif any(populated_publication):
        raise ExecutionContractError("executor result cannot assert trusted publication identity")
    if branch is not None:
        _nonempty(branch, "branch")
    if commit_sha is not None and (not isinstance(commit_sha, str) or not _COMMIT.fullmatch(commit_sha)):
        raise ExecutionContractError("commitSha is invalid")
    if draft_pr is not None:
        if not isinstance(draft_pr, dict) or set(draft_pr) != {"number", "url", "isDraft"}:
            raise ExecutionContractError("draftPr fields are invalid")
        if not isinstance(draft_pr["number"], int) or draft_pr["number"] < 1 or draft_pr["isDraft"] is not True:
            raise ExecutionContractError("draftPr must identify a draft pull request")
        _nonempty(draft_pr["url"], "draftPr.url")
    classification = value["failureClassification"]
    if classification not in FAILURE_CLASSIFICATIONS:
        raise ExecutionContractError("failure classification is invalid")
    if value["disposition"] == "EXECUTION_SUCCEEDED" and classification != "NONE":
        raise ExecutionContractError("successful execution cannot carry a failure classification")
    if value["disposition"] != "EXECUTION_SUCCEEDED" and classification == "NONE":
        raise ExecutionContractError("unsuccessful execution requires a failure classification")
    provenance = value["provenance"]
    expected_provenance_fields = {
        "runtimeName", "runtimeVersion", "model", "launcherVersion", "profileFingerprint",
        "observedExecutorIdentity",
    }
    if not isinstance(provenance, dict) or set(provenance) != expected_provenance_fields:
        raise ExecutionContractError("execution provenance fields are invalid")
    if provenance["profileFingerprint"] != request.executor_profile_fingerprint:
        raise ExecutionContractError("execution provenance profile fingerprint mismatch")
    for field in expected_provenance_fields - {"profileFingerprint", "observedExecutorIdentity"}:
        _nonempty(provenance[field], f"provenance.{field}")
    if provenance["observedExecutorIdentity"] != json.loads(request.observed_executor_identity_json):
        raise ExecutionContractError("execution provenance observed identity mismatch")
    return value


def result_fields() -> frozenset[str]:
    return frozenset(_RESULT_FIELDS)
