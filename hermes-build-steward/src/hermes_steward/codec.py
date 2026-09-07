from __future__ import annotations

import copy
from datetime import datetime
from typing import Any, Mapping

from .coordinator import Lease, TaskRecord
from .contracts import fingerprint, validate_versioned_build_task
from .state import TaskStatus


def _lease_to_dict(lease: Lease | None) -> dict[str, Any] | None:
    if lease is None:
        return None
    return {
        "taskId": lease.task_id,
        "attemptId": lease.attempt_id,
        "workerId": lease.worker_id,
        "leaseId": lease.lease_id,
        "leaseStartedAt": lease.lease_started_at.isoformat(),
        "leaseExpiresAt": lease.lease_expires_at.isoformat(),
        "fencingToken": lease.fencing_token,
    }


def record_to_dict(record: TaskRecord) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "key": record.key,
        "task": copy.deepcopy(record.task),
        "taskFingerprint": record.task_fingerprint,
        "status": record.status.value,
        "attemptCount": record.attempt_count,
        "fencingCounter": record.fencing_counter,
        "activeLease": _lease_to_dict(record.active_lease),
        "results": copy.deepcopy(record.results),
        "failureHistory": copy.deepcopy(record.failure_history),
        "audit": copy.deepcopy(record.audit),
        "unavailableProfileFingerprints": list(record.unavailable_profile_fingerprints),
        "nextFallbackIndex": record.next_fallback_index,
        "pendingFallbackProfileId": record.pending_fallback_profile_id,
        "pendingFallbackProfileFingerprint": record.pending_fallback_profile_fingerprint,
        "primaryFailureAttemptId": record.primary_failure_attempt_id,
        "activeExecutorProfileId": record.active_executor_profile_id,
        "activeExecutorProfileFingerprint": record.active_executor_profile_fingerprint,
    }


def _parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("persisted timestamp lacks timezone")
    return parsed


def record_from_dict(raw: Mapping[str, Any]) -> TaskRecord:
    legacy = {
        "schemaVersion", "key", "task", "taskFingerprint", "status", "attemptCount",
        "fencingCounter", "activeLease", "results", "failureHistory", "audit",
    }
    added = {
        "unavailableProfileFingerprints", "nextFallbackIndex", "pendingFallbackProfileId",
        "pendingFallbackProfileFingerprint", "primaryFailureAttemptId",
    }
    selection = {"activeExecutorProfileId", "activeExecutorProfileFingerprint"}
    if frozenset(raw) not in {
        frozenset(legacy), frozenset(legacy | added), frozenset(legacy | added | selection)
    } or raw["schemaVersion"] != "1.0":
        raise ValueError("persisted task record schema is invalid")
    task = validate_versioned_build_task(raw["task"])
    if raw["taskFingerprint"] != fingerprint(task):
        raise ValueError("persisted task fingerprint does not match task payload")
    expected_key_suffix = f":{task['taskId']}:{task['taskVersion']}"
    if not isinstance(raw["key"], str) or not raw["key"].endswith(expected_key_suffix) or raw["key"] == expected_key_suffix:
        raise ValueError("persisted task key does not match task identity")
    if not isinstance(raw["attemptCount"], int) or isinstance(raw["attemptCount"], bool) or raw["attemptCount"] < 0:
        raise ValueError("persisted attemptCount is invalid")
    if not isinstance(raw["fencingCounter"], int) or isinstance(raw["fencingCounter"], bool) or raw["fencingCounter"] < 0:
        raise ValueError("persisted fencingCounter is invalid")
    if raw["attemptCount"] != raw["fencingCounter"]:
        raise ValueError("persisted attempt and fencing counters are inconsistent")
    for field in ("results", "failureHistory", "audit"):
        if not isinstance(raw[field], list):
            raise ValueError(f"persisted {field} is invalid")
    status = TaskStatus(raw["status"])
    lease_raw = raw["activeLease"]
    lease = None
    if lease_raw is not None:
        if set(lease_raw) != {"taskId", "attemptId", "workerId", "leaseId", "leaseStartedAt", "leaseExpiresAt", "fencingToken"}:
            raise ValueError("persisted lease schema is invalid")
        lease = Lease(
            task_id=lease_raw["taskId"], attempt_id=lease_raw["attemptId"],
            worker_id=lease_raw["workerId"], lease_id=lease_raw["leaseId"],
            lease_started_at=_parse_timestamp(lease_raw["leaseStartedAt"]),
            lease_expires_at=_parse_timestamp(lease_raw["leaseExpiresAt"]),
            fencing_token=lease_raw["fencingToken"],
        )
        if lease.task_id != task["taskId"] or lease.fencing_token != raw["fencingCounter"] or lease.fencing_token < 1:
            raise ValueError("persisted lease task or fencing invariant is invalid")
        if lease.lease_started_at >= lease.lease_expires_at:
            raise ValueError("persisted lease timestamps are invalid")
        if status not in {TaskStatus.LEASED, TaskStatus.VERIFYING}:
            raise ValueError("persisted active lease is inconsistent with task status")
    elif status in {TaskStatus.LEASED, TaskStatus.VERIFYING}:
        raise ValueError("persisted leased task is missing its active lease")
    result_attempts = [item.get("attemptId") for item in raw["results"] if isinstance(item, dict)]
    if len(result_attempts) != len(raw["results"]) or len(result_attempts) != len(set(result_attempts)):
        raise ValueError("persisted results contain invalid or duplicate attempt identities")
    if len(raw["results"]) > raw["attemptCount"]:
        raise ValueError("persisted results exceed recorded attempts")
    unavailable = raw.get("unavailableProfileFingerprints", [])
    next_fallback_index = raw.get("nextFallbackIndex", 0)
    pending_id = raw.get("pendingFallbackProfileId")
    pending_fingerprint = raw.get("pendingFallbackProfileFingerprint")
    primary_attempt = raw.get("primaryFailureAttemptId")
    active_profile_id = raw.get("activeExecutorProfileId")
    active_profile_fingerprint = raw.get("activeExecutorProfileFingerprint")
    if (
        not isinstance(unavailable, list) or len(unavailable) != len(set(unavailable))
        or any(not isinstance(item, str) or len(item) != 64 for item in unavailable)
        or not isinstance(next_fallback_index, int) or isinstance(next_fallback_index, bool) or next_fallback_index < 0
        or (pending_id is None) != (pending_fingerprint is None)
        or (pending_id is not None and (not isinstance(pending_id, str) or not pending_id))
        or (pending_fingerprint is not None and (not isinstance(pending_fingerprint, str) or len(pending_fingerprint) != 64))
        or (primary_attempt is not None and (not isinstance(primary_attempt, str) or not primary_attempt))
        or (active_profile_id is None) != (active_profile_fingerprint is None)
        or (active_profile_id is not None and (not isinstance(active_profile_id, str) or not active_profile_id))
        or (active_profile_fingerprint is not None and (not isinstance(active_profile_fingerprint, str) or len(active_profile_fingerprint) != 64))
    ):
        raise ValueError("persisted fallback state is invalid")
    if pending_fingerprint is not None and status != TaskStatus.REWORK_REQUIRED and not (
        status == TaskStatus.LEASED and lease is not None and active_profile_fingerprint is None
    ):
        raise ValueError("persisted pending fallback state is inconsistent")
    if active_profile_fingerprint is not None and lease is None:
        raise ValueError("persisted active executor selection lacks its lease")
    if task["schemaVersion"] == "2.0" and lease is not None and active_profile_fingerprint is None:
        references = [task["dispatchPolicy"]["executorProfile"], *task["dispatchPolicy"]["permittedFallbackProfiles"]]
        if pending_fingerprint is not None:
            selected = {"profileId": pending_id, "profileFingerprint": pending_fingerprint}
            pending_id = pending_fingerprint = None
        else:
            selected = next((item for item in references if item["profileFingerprint"] not in unavailable), None)
        if selected is None:
            raise ValueError("persisted lease has no authorized executor selection")
        active_profile_id = selected["profileId"]
        active_profile_fingerprint = selected["profileFingerprint"]
    return TaskRecord(
        key=raw["key"], task=task,
        task_fingerprint=raw["taskFingerprint"], status=status,
        attempt_count=raw["attemptCount"], fencing_counter=raw["fencingCounter"],
        active_lease=lease, results=copy.deepcopy(raw["results"]),
        failure_history=copy.deepcopy(raw["failureHistory"]), audit=copy.deepcopy(raw["audit"]),
        unavailable_profile_fingerprints=list(unavailable), next_fallback_index=next_fallback_index,
        pending_fallback_profile_id=pending_id,
        pending_fallback_profile_fingerprint=pending_fingerprint,
        primary_failure_attempt_id=primary_attempt,
        active_executor_profile_id=active_profile_id,
        active_executor_profile_fingerprint=active_profile_fingerprint,
    )
