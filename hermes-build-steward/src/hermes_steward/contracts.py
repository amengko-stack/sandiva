from __future__ import annotations

import copy
import fnmatch
import hashlib
import json
import re
import shlex
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse


class ContractValidationError(ValueError):
    pass


REQUIRED_TASK_FIELDS = {
    "schemaVersion", "taskId", "taskVersion", "originatingPmInstructionRef",
    "originatingPmInstructionFingerprint", "specificationRef", "specificationVersion",
    "specificationHash", "acceptanceContractRef", "acceptanceContractVersion",
    "acceptanceContractHash", "repository", "baseRef", "scope", "acceptanceCriteria",
    "permittedRepositoryAreas", "prohibitedRepositoryAreas", "riskLevel", "executorPolicy",
    "executionStatus", "branchRef", "prRef", "commitRefs", "evaluationRequirements",
    "qaRequirements", "partnerGateStatus", "retryPolicy", "attemptCount", "failureHistory",
    "permissionEnvelopeRef", "provenance", "auditMetadata", "createdAt", "updatedAt",
}
_HASH = re.compile(r"^[0-9a-f]{64}$")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_SECRET_SUFFIXES = ("secret", "password", "credential", "privatekey", "apikey", "accesstoken", "refreshtoken", "bearertoken")
MAX_TASK_BYTES = 8192
MAX_ATTEMPTS = 3


def _nonempty_string(value: Any, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ContractValidationError(f"{field} must be a non-empty string")


def _timestamp(value: Any, field: str) -> None:
    _nonempty_string(value, field)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ContractValidationError(f"{field} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ContractValidationError(f"{field} must include a timezone")


def _string_list(value: Any, field: str, *, allow_empty: bool = False) -> None:
    if not isinstance(value, list) or (not allow_empty and not value):
        raise ContractValidationError(f"{field} must be a list" + ("" if allow_empty else " with at least one item"))
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise ContractValidationError(f"{field} entries must be non-empty strings")


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def reject_secret_fields(value: Any, path: str = "payload") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            normalized = str(key).replace("_", "").replace("-", "").lower()
            if normalized == "token" or normalized.endswith(_SECRET_SUFFIXES):
                raise ContractValidationError(f"secret-bearing field is prohibited in Build Task: {path}.{key}")
            reject_secret_fields(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            reject_secret_fields(item, f"{path}[{index}]")


def validate_build_task(raw: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise ContractValidationError("Build Task must be an object")
    supplied = set(raw)
    missing = REQUIRED_TASK_FIELDS - supplied
    unknown = supplied - REQUIRED_TASK_FIELDS
    if missing:
        raise ContractValidationError(f"missing required fields: {', '.join(sorted(missing))}")
    if unknown:
        raise ContractValidationError(f"unknown fields fail closed: {', '.join(sorted(unknown))}")

    task = copy.deepcopy(dict(raw))
    reject_secret_fields(task, "task")
    if task["schemaVersion"] != "1.0":
        raise ContractValidationError("schemaVersion must be 1.0")
    if not isinstance(task["taskId"], str) or not _ID.fullmatch(task["taskId"]):
        raise ContractValidationError("taskId has an invalid format")
    if not isinstance(task["taskVersion"], int) or isinstance(task["taskVersion"], bool) or task["taskVersion"] < 1:
        raise ContractValidationError("taskVersion must be a positive integer")
    for field in (
        "originatingPmInstructionRef", "specificationRef", "specificationVersion",
        "acceptanceContractRef", "acceptanceContractVersion", "riskLevel", "permissionEnvelopeRef",
    ):
        _nonempty_string(task[field], field)
    for field in ("originatingPmInstructionFingerprint", "specificationHash", "acceptanceContractHash"):
        if not isinstance(task[field], str) or not _HASH.fullmatch(task[field]):
            raise ContractValidationError(f"{field} must be a lowercase SHA-256 digest")
    parsed_repository = urlparse(task["repository"] if isinstance(task["repository"], str) else "")
    repository_parts = parsed_repository.path.strip("/").split("/")
    if (
        parsed_repository.scheme != "https"
        or parsed_repository.netloc.lower() != "github.com"
        or parsed_repository.username is not None
        or len(repository_parts) != 2
        or any(not part for part in repository_parts)
        or parsed_repository.params
        or parsed_repository.query
        or parsed_repository.fragment
    ):
        raise ContractValidationError("repository must be a canonical HTTPS GitHub repository URL")
    if not isinstance(task["baseRef"], str) or not _COMMIT.fullmatch(task["baseRef"]):
        raise ContractValidationError("baseRef must be an immutable 40-character commit SHA")
    for field in ("scope", "acceptanceCriteria", "permittedRepositoryAreas", "prohibitedRepositoryAreas", "evaluationRequirements", "qaRequirements"):
        _string_list(task[field], field)
        if len(task[field]) != len(set(task[field])):
            raise ContractValidationError(f"{field} must not contain duplicates")
    _string_list(task["commitRefs"], "commitRefs", allow_empty=True)
    if any(not _COMMIT.fullmatch(commit) for commit in task["commitRefs"]):
        raise ContractValidationError("commitRefs must contain immutable commit SHAs")
    if task["executionStatus"] != "CREATED":
        raise ContractValidationError("new Build Task executionStatus must be CREATED")
    for field in ("branchRef", "prRef"):
        if task[field] is not None and (not isinstance(task[field], str) or not task[field].strip()):
            raise ContractValidationError(f"{field} must be null or a non-empty string")
    for field in ("executorPolicy", "retryPolicy", "provenance", "auditMetadata"):
        if not isinstance(task[field], dict):
            raise ContractValidationError(f"{field} must be an object")
    if task["executorPolicy"].get("automaticDispatch") is not False:
        raise ContractValidationError("Phase 1 executorPolicy.automaticDispatch must be false")
    max_attempts = task["retryPolicy"].get("maxAttempts")
    if not isinstance(max_attempts, int) or isinstance(max_attempts, bool) or max_attempts < 1:
        raise ContractValidationError("retryPolicy.maxAttempts must be a positive integer")
    if max_attempts > MAX_ATTEMPTS:
        raise ContractValidationError(f"retryPolicy.maxAttempts must be at most {MAX_ATTEMPTS}")
    if task["attemptCount"] != 0:
        raise ContractValidationError("new Build Task attemptCount must be zero")
    if not isinstance(task["failureHistory"], list):
        raise ContractValidationError("failureHistory must be a list")
    _nonempty_string(task["partnerGateStatus"], "partnerGateStatus")
    _timestamp(task["createdAt"], "createdAt")
    _timestamp(task["updatedAt"], "updatedAt")
    if datetime.fromisoformat(task["updatedAt"].replace("Z", "+00:00")) < datetime.fromisoformat(task["createdAt"].replace("Z", "+00:00")):
        raise ContractValidationError("updatedAt cannot precede createdAt")
    if len(canonical_json(task)) > MAX_TASK_BYTES:
        raise ContractValidationError(f"Build Task exceeds the {MAX_TASK_BYTES}-byte size limit")
    return task


def validate_reference_hashes(task: Mapping[str, Any], specification: bytes, acceptance_contract: bytes) -> None:
    specification_hash = hashlib.sha256(specification).hexdigest()
    acceptance_hash = hashlib.sha256(acceptance_contract).hexdigest()
    if specification_hash != task["specificationHash"]:
        raise ContractValidationError("specificationHash does not match retrieved canonical bytes")
    if acceptance_hash != task["acceptanceContractHash"]:
        raise ContractValidationError("acceptanceContractHash does not match retrieved canonical bytes")


def _matches(path: str, pattern: str) -> bool:
    clean_pattern = pattern.replace("\\", "/")
    if clean_pattern.endswith("/**"):
        prefix = clean_pattern[:-3].rstrip("/")
        return path == prefix or path.startswith(prefix + "/")
    return fnmatch.fnmatchcase(path, clean_pattern)


def validate_repository_paths(task: Mapping[str, Any], paths: Sequence[str]) -> None:
    permitted = task["permittedRepositoryAreas"]
    prohibited = task["prohibitedRepositoryAreas"]
    for raw_path in paths:
        if not isinstance(raw_path, str) or not raw_path:
            raise ContractValidationError("repository path must be a non-empty string")
        path = raw_path.replace("\\", "/")
        parts = PurePosixPath(path).parts
        if path.startswith("/") or ".." in parts:
            raise ContractValidationError(f"repository path escapes root: {raw_path}")
        if any(_matches(path, pattern) for pattern in prohibited):
            raise ContractValidationError(f"repository path is prohibited: {raw_path}")
        if not any(_matches(path, pattern) for pattern in permitted):
            raise ContractValidationError(f"repository path is outside the permission envelope: {raw_path}")


def validate_verification_command(task: Mapping[str, Any], command: Sequence[str]) -> None:
    if not command or any(not isinstance(part, str) or not part for part in command):
        raise ContractValidationError("verification command must be a non-empty argument vector")
    approved = task["executorPolicy"].get("approvedCommands")
    if not isinstance(approved, list) or any(not isinstance(item, str) for item in approved):
        raise ContractValidationError("executorPolicy.approvedCommands must be a list of exact commands")
    rendered = shlex.join(list(command))
    if rendered not in approved:
        raise ContractValidationError("verification command is not authorized by the Build Task")
