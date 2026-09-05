from __future__ import annotations

import copy
import json
from datetime import datetime
from typing import Any, Mapping

from .contracts import ContractValidationError, reject_secret_fields


class ResultValidationError(ValueError):
    pass


REQUIRED_RESULT_FIELDS = {
    "schemaVersion", "taskId", "attemptId", "HermesVersion", "configFingerprint",
    "workerIdentity", "leaseId", "fencingToken", "specificationRef", "specificationHash",
    "acceptanceContractRef", "acceptanceContractHash", "repository", "baseRef", "branchRef",
    "prRef", "commitRefs", "deterministicEvidence", "semanticEvidence",
    "acceptanceCriteriaResults", "result", "residualRisks", "retryInformation", "timestamps",
    "auditReferences",
}


def validate_job_result(raw: bytes, task: Mapping[str, Any], lease: Any, max_bytes: int) -> dict[str, Any]:
    if len(raw) > max_bytes:
        raise ResultValidationError("result exceeds configured size limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ResultValidationError("result is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ResultValidationError("result must be a JSON object")
    try:
        reject_secret_fields(value, "result")
    except ContractValidationError as error:
        raise ResultValidationError(str(error)) from error
    missing = REQUIRED_RESULT_FIELDS - set(value)
    unknown = set(value) - REQUIRED_RESULT_FIELDS
    if missing or unknown:
        raise ResultValidationError(f"result fields invalid; missing={sorted(missing)} unknown={sorted(unknown)}")
    expected = {
        "taskId": task["taskId"], "attemptId": lease.attempt_id, "leaseId": lease.lease_id,
        "fencingToken": lease.fencing_token, "specificationRef": task["specificationRef"],
        "specificationHash": task["specificationHash"],
        "acceptanceContractRef": task["acceptanceContractRef"],
        "acceptanceContractHash": task["acceptanceContractHash"], "repository": task["repository"],
        "baseRef": task["baseRef"], "branchRef": task["branchRef"], "prRef": task["prRef"],
        "commitRefs": task["commitRefs"],
    }
    for field, expected_value in expected.items():
        if value[field] != expected_value:
            raise ResultValidationError(f"result {field} does not match trusted coordinator state")
    if value["schemaVersion"] != "1.0" or value["result"] not in {"PASS", "FAIL", "PARTNER_DECISION_REQUIRED"}:
        raise ResultValidationError("result schemaVersion or disposition is invalid")
    for field in ("taskId", "attemptId", "HermesVersion", "configFingerprint", "workerIdentity", "leaseId"):
        if not isinstance(value[field], str) or not value[field].strip():
            raise ResultValidationError(f"result {field} must be a non-empty string")
    if not isinstance(value["fencingToken"], int) or isinstance(value["fencingToken"], bool) or value["fencingToken"] < 1:
        raise ResultValidationError("result fencingToken must be a positive integer")
    if not isinstance(value["deterministicEvidence"], list) or not isinstance(value["semanticEvidence"], list) or not isinstance(value["acceptanceCriteriaResults"], list):
        raise ResultValidationError("result evidence fields must be lists")
    if any(not isinstance(item, dict) for field in ("deterministicEvidence", "semanticEvidence") for item in value[field]):
        raise ResultValidationError("evidence entries must be objects")
    if value["result"] == "PASS" and not value["deterministicEvidence"]:
        raise ResultValidationError("PASS requires deterministic evidence")
    criteria = value["acceptanceCriteriaResults"]
    if any(not isinstance(item, dict) or set(item) != {"criterion", "result", "evidenceRefs"} for item in criteria):
        raise ResultValidationError("acceptanceCriteriaResults entries are invalid")
    names = [item["criterion"] for item in criteria]
    if len(names) != len(set(names)) or set(names) != set(task["acceptanceCriteria"]):
        raise ResultValidationError("result must evaluate every acceptance criterion exactly once")
    for item in criteria:
        if item["result"] not in {"PASS", "FAIL", "PARTNER_DECISION_REQUIRED"}:
            raise ResultValidationError("acceptance criterion disposition is invalid")
        if (
            not isinstance(item["criterion"], str)
            or not item["criterion"].strip()
            or not isinstance(item["evidenceRefs"], list)
            or not item["evidenceRefs"]
            or any(not isinstance(reference, str) or not reference.strip() for reference in item["evidenceRefs"])
        ):
            raise ResultValidationError("each acceptance criterion requires evidence references")
    criterion_dispositions = {item["result"] for item in criteria}
    expected_disposition = (
        "PARTNER_DECISION_REQUIRED"
        if "PARTNER_DECISION_REQUIRED" in criterion_dispositions
        else "FAIL" if "FAIL" in criterion_dispositions else "PASS"
    )
    if value["result"] != expected_disposition:
        raise ResultValidationError("overall result must match the acceptance-criterion dispositions")
    for field in ("residualRisks", "auditReferences"):
        if not isinstance(value[field], list) or any(not isinstance(item, str) or not item.strip() for item in value[field]):
            raise ResultValidationError(f"result {field} must contain only non-empty strings")
    if not isinstance(value["retryInformation"], dict):
        raise ResultValidationError("result retryInformation must be an object")
    timestamps = value["timestamps"]
    if not isinstance(timestamps, dict) or set(timestamps) != {"startedAt", "completedAt"}:
        raise ResultValidationError("result timestamps must contain startedAt and completedAt")
    try:
        started = datetime.fromisoformat(timestamps["startedAt"].replace("Z", "+00:00"))
        completed = datetime.fromisoformat(timestamps["completedAt"].replace("Z", "+00:00"))
    except (AttributeError, ValueError) as error:
        raise ResultValidationError("result timestamps must be ISO-8601 strings") from error
    if started.tzinfo is None or completed.tzinfo is None or completed < started:
        raise ResultValidationError("result timestamps must be timezone-aware and ordered")
    return copy.deepcopy(value)


def normalize_and_validate_result(candidate: Mapping[str, Any], task: Mapping[str, Any], lease: Any, config: Any) -> dict[str, Any]:
    normalized = copy.deepcopy(dict(candidate))
    normalized["HermesVersion"] = config.hermes_version
    normalized["configFingerprint"] = config.fingerprint
    normalized["workerIdentity"] = lease.worker_id
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return validate_job_result(encoded, task, lease, config.result_max_bytes)
