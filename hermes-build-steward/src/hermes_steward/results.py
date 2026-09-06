from __future__ import annotations

import copy
import json
from datetime import datetime
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse

from .contracts import (
    ALLOWED_EVIDENCE_KINDS_BY_ORIGIN,
    ContractValidationError,
    reject_secret_fields,
)
from .evidence import TrustedEvidence


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

_RAW_EVIDENCE_FIELDS = {"evidenceRef", "kind", "source", "result", "criteria", "details"}
_NORMALIZED_EVIDENCE_FIELDS = _RAW_EVIDENCE_FIELDS | {"trustedOrigin"}
_EVIDENCE_RESULTS = {"PASS", "FAIL", "PARTNER_DECISION_REQUIRED"}


def _nonempty_uri(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    parsed = urlparse(value)
    return bool(parsed.scheme and (parsed.netloc or parsed.path))


def _validate_evidence_record(record: Mapping[str, Any], task: Mapping[str, Any]) -> None:
    if set(record) != _NORMALIZED_EVIDENCE_FIELDS:
        raise ResultValidationError("evidence record structure is invalid")
    if not _nonempty_uri(record["evidenceRef"]) or not _nonempty_uri(record["source"]):
        raise ResultValidationError("evidence identity and source must be stable URI references")
    if record["result"] not in _EVIDENCE_RESULTS:
        raise ResultValidationError("evidence result is invalid")
    if record["trustedOrigin"] not in {
        "ISOLATED_VERIFICATION_JOB", "TRUSTED_COORDINATOR", "TRUSTED_EXTERNAL_SYSTEM"
    }:
        raise ResultValidationError("evidence trusted origin is invalid")
    if record["kind"] not in ALLOWED_EVIDENCE_KINDS_BY_ORIGIN[record["trustedOrigin"]]:
        raise ResultValidationError("trusted origin does not authorize evidence kind")
    criteria = record["criteria"]
    if (
        not isinstance(criteria, list)
        or not criteria
        or any(not isinstance(item, str) or not item.strip() for item in criteria)
        or len(criteria) != len(set(criteria))
        or not set(criteria).issubset(set(task["acceptanceCriteria"]))
    ):
        raise ResultValidationError("evidence criteria mapping is invalid")
    if not isinstance(record["details"], dict):
        raise ResultValidationError("evidence details must be an object")


def _normalize_job_evidence(records: Any, task: Mapping[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(records, list):
        raise ResultValidationError("result evidence fields must be lists")
    normalized = []
    for item in records:
        if not isinstance(item, dict) or set(item) != _RAW_EVIDENCE_FIELDS:
            raise ResultValidationError("untrusted job evidence structure is invalid")
        if item["kind"] != "isolated-job-observation":
            raise ResultValidationError("untrusted job evidence kind is not permitted")
        if item["result"] == "PARTNER_DECISION_REQUIRED":
            raise ResultValidationError("untrusted job evidence cannot raise a Partner Decision")
        record = copy.deepcopy(item)
        record["trustedOrigin"] = "ISOLATED_VERIFICATION_JOB"
        _validate_evidence_record(record, task)
        normalized.append(record)
    return normalized


def _normalize_trusted_evidence(
    trusted_evidence: Sequence[TrustedEvidence], task: Mapping[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    deterministic = []
    semantic = []
    for item in trusted_evidence:
        if not isinstance(item, TrustedEvidence) or not item.acquired_by_trusted_path:
            raise ResultValidationError("trusted evidence must come from a coordinator acquisition path")
        record = item.as_record()
        try:
            reject_secret_fields(record, "trusted evidence")
        except ContractValidationError as error:
            raise ResultValidationError(str(error)) from error
        _validate_evidence_record(record, task)
        if item.category == "deterministic":
            deterministic.append(record)
        elif item.category == "semantic":
            semantic.append(record)
        else:
            raise ResultValidationError("trusted evidence category is invalid")
    return deterministic, semantic


def validate_job_result(
    raw: bytes,
    task: Mapping[str, Any],
    lease: Any,
    max_bytes: int,
    *,
    trusted_evidence: Sequence[TrustedEvidence] = (),
) -> dict[str, Any]:
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
    deterministic = _normalize_job_evidence(value["deterministicEvidence"], task)
    if not isinstance(value["semanticEvidence"], list):
        raise ResultValidationError("result evidence fields must be lists")
    if value["semanticEvidence"]:
        raise ResultValidationError("untrusted job cannot supply semantic evidence")
    semantic = []
    trusted_deterministic, trusted_semantic = _normalize_trusted_evidence(trusted_evidence, task)
    value["deterministicEvidence"] = deterministic + trusted_deterministic
    value["semanticEvidence"] = semantic + trusted_semantic
    if not isinstance(value["acceptanceCriteriaResults"], list):
        raise ResultValidationError("acceptanceCriteriaResults must be a list")
    if value["result"] == "PASS" and not value["deterministicEvidence"]:
        raise ResultValidationError("PASS requires deterministic evidence")
    all_evidence = value["deterministicEvidence"] + value["semanticEvidence"]
    evidence_references = [item["evidenceRef"] for item in all_evidence]
    if len(evidence_references) != len(set(evidence_references)):
        raise ResultValidationError("duplicate evidence identity")
    evidence_by_ref = {item["evidenceRef"]: item for item in all_evidence}
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
        if len(item["evidenceRefs"]) != len(set(item["evidenceRefs"])):
            raise ResultValidationError("acceptance criterion contains duplicate evidence references")
        resolved = []
        try:
            policy = task["criterionEvidencePolicy"][item["criterion"]]["allowedEvidence"]
            allowed_evidence = {(entry["origin"], entry["kind"]) for entry in policy}
        except (KeyError, TypeError) as error:
            raise ResultValidationError("trusted task criterion evidence policy is invalid") from error
        for reference in item["evidenceRefs"]:
            evidence = evidence_by_ref.get(reference)
            if evidence is None:
                raise ResultValidationError(f"unknown evidence reference for criterion {item['criterion']}")
            if item["criterion"] not in evidence["criteria"]:
                raise ResultValidationError(
                    f"evidence reference {reference} does not prove criterion {item['criterion']}"
                )
            if (evidence["trustedOrigin"], evidence["kind"]) not in allowed_evidence:
                raise ResultValidationError(
                    f"evidence reference {reference} is not authorized by criterion evidence policy"
                )
            resolved.append(evidence)
        if item["result"] == "PASS" and any(evidence["result"] != "PASS" for evidence in resolved):
            raise ResultValidationError("PASS criterion requires only PASS evidence")
        if item["result"] == "FAIL" and not any(evidence["result"] == "FAIL" for evidence in resolved):
            raise ResultValidationError("FAIL criterion requires FAIL evidence")
        if item["result"] == "PARTNER_DECISION_REQUIRED":
            if not any(evidence["result"] == "PARTNER_DECISION_REQUIRED" for evidence in resolved):
                raise ResultValidationError("Partner Decision criterion requires matching evidence")
            if any(evidence["trustedOrigin"] != "TRUSTED_COORDINATOR" for evidence in resolved):
                raise ResultValidationError("Partner Decision evidence must originate from the trusted coordinator")
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
    normalized_bytes = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(normalized_bytes) > max_bytes:
        raise ResultValidationError("normalized result exceeds configured size limit")
    return copy.deepcopy(value)


def normalize_and_validate_result(
    candidate: Mapping[str, Any],
    task: Mapping[str, Any],
    lease: Any,
    config: Any,
    *,
    trusted_evidence: Sequence[TrustedEvidence] = (),
) -> dict[str, Any]:
    normalized = copy.deepcopy(dict(candidate))
    normalized["HermesVersion"] = config.hermes_version
    normalized["configFingerprint"] = config.fingerprint
    normalized["workerIdentity"] = lease.worker_id
    encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return validate_job_result(
        encoded, task, lease, config.result_max_bytes, trusted_evidence=trusted_evidence
    )
