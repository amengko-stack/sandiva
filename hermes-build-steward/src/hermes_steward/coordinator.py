from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Sequence

from .audit import sanitize_audit_value
from .contracts import canonical_json, fingerprint, validate_build_task, validate_reference_hashes
from .evidence import (
    GitHubEvidenceReader,
    TrustedEvidence,
    coordinator_observation_evidence,
    retrieve_github_ci_evidence,
)
from .results import normalize_and_validate_result
from .state import TaskStatus, validate_transition
from .store import RecordNotFound, StateStore, StoreConflict


class CoordinatorError(RuntimeError):
    pass


class StaleFenceError(CoordinatorError):
    pass


@dataclass
class Lease:
    task_id: str
    attempt_id: str
    worker_id: str
    lease_id: str
    lease_started_at: datetime
    lease_expires_at: datetime
    fencing_token: int


@dataclass
class TaskRecord:
    key: str
    task: dict[str, Any]
    task_fingerprint: str
    status: TaskStatus
    attempt_count: int = 0
    fencing_counter: int = 0
    active_lease: Lease | None = None
    results: list[dict[str, Any]] = field(default_factory=list)
    failure_history: list[dict[str, Any]] = field(default_factory=list)
    audit: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class _NoWrite:
    value: TaskRecord


@dataclass(frozen=True)
class _RejectedMutation:
    message: str


_RESERVED_PARTNER_GATE_REASONS = {
    "material architecture change", "confidentiality/security policy", "legal-output governance",
    "provider/model governance", "authority/review policy", "retention/provenance policy",
    "material recurring-cost commitment", "acceptance of significant known limitation", "class c decision",
}


class Coordinator:
    def __init__(self, store: StateStore[TaskRecord], config: Any, *, clock: Callable[[], datetime] | None = None):
        self.store = store
        self.config = config
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def _key(self, task_id: str, task_version: int) -> str:
        return f"{self.config.task_namespace}:{task_id}:{task_version}"

    def _event(self, record: TaskRecord, event: str, **details: Any) -> None:
        record.audit.append(
            {
                "event": event,
                "at": self.clock().isoformat(),
                "environmentIdentity": self.config.environment_id,
                "workerIdentity": self.config.worker_identity,
                "configurationFingerprint": self.config.fingerprint,
                "details": sanitize_audit_value(details),
            }
        )

    def _transition(self, record: TaskRecord, target: TaskStatus, reason: str) -> None:
        validate_transition(record.status, target)
        previous = record.status
        record.status = target
        self._event(record, "STATE_TRANSITION", previous=previous.value, target=target.value, reason=reason)

    def submit_task(
        self,
        raw_task: Mapping[str, Any],
        specification: bytes | None = None,
        acceptance_contract: bytes | None = None,
    ) -> TaskRecord:
        task = validate_build_task(raw_task)
        if self.config.environment_kind == "production":
            if specification is None or acceptance_contract is None:
                raise ValueError("production submission requires retrieved canonical bytes")
            validate_reference_hashes(task, specification, acceptance_contract)
        key = self._key(task["taskId"], task["taskVersion"])
        task_fingerprint = fingerprint(task)
        record = TaskRecord(key=key, task=task, task_fingerprint=task_fingerprint, status=TaskStatus.CREATED)
        self._event(record, "TASK_CREATED", taskId=task["taskId"], taskVersion=task["taskVersion"], taskFingerprint=task_fingerprint)
        self._transition(record, TaskStatus.READY, "validated canonical Build Task")
        try:
            return self.store.create(key, record).value
        except StoreConflict:
            existing = self.store.get(key).value
            if existing.task_fingerprint != task_fingerprint:
                raise CoordinatorError("conflicting duplicate task delivery")
            return existing

    def _mutate(self, key: str, mutation: Callable[[TaskRecord], Any], *, retries: int = 16) -> Any:
        for _ in range(retries):
            versioned = self.store.get(key)
            record = versioned.value
            response = mutation(record)
            if isinstance(response, _NoWrite):
                return response.value
            try:
                persisted = self.store.compare_and_swap(key, versioned.etag, record)
                return persisted.value if response is None else self._map_response(response, record, persisted.value)
            except StoreConflict:
                continue
        raise CoordinatorError("state contention exceeded retry limit")

    @staticmethod
    def _map_response(response: Any, before: TaskRecord, persisted: TaskRecord) -> Any:
        if response is before:
            return persisted
        if isinstance(response, Lease) and persisted.active_lease is not None:
            return copy.deepcopy(persisted.active_lease)
        return response

    def claim(self, task_id: str, task_version: int, worker_id: str, ttl_seconds: int) -> Lease:
        if ttl_seconds < 1:
            raise CoordinatorError("lease TTL must be positive")
        key = self._key(task_id, task_version)

        def mutation(record: TaskRecord) -> Lease | _RejectedMutation:
            now = self.clock()
            active = record.active_lease
            if active is not None and active.lease_expires_at > now:
                raise CoordinatorError("task already has a valid lease owner")
            if record.status == TaskStatus.VERIFYING:
                raise CoordinatorError("expired VERIFYING attempt requires reconciliation before takeover")
            if record.status == TaskStatus.LEASED:
                self._event(record, "LEASE_EXPIRED", leaseId=active.lease_id if active else None, fencingToken=active.fencing_token if active else None)
                record.active_lease = None
                self._transition(record, TaskStatus.READY, "expired unstarted lease released")
            if record.status == TaskStatus.REWORK_REQUIRED:
                self._transition(record, TaskStatus.READY, "rework attempt made ready")
            if record.status != TaskStatus.READY:
                raise CoordinatorError(f"task is not claimable from {record.status.value}")
            if record.attempt_count >= record.task["retryPolicy"]["maxAttempts"]:
                self._transition(record, TaskStatus.FAILED, "retry limit exhausted")
                return _RejectedMutation("retry limit exhausted")
            record.attempt_count += 1
            record.fencing_counter += 1
            attempt_id = "attempt-" + str(uuid.uuid5(uuid.NAMESPACE_URL, f"{record.key}:attempt:{record.attempt_count}"))
            lease = Lease(
                task_id=task_id, attempt_id=attempt_id, worker_id=worker_id,
                lease_id="lease-" + str(uuid.uuid4()), lease_started_at=now,
                lease_expires_at=now + timedelta(seconds=ttl_seconds), fencing_token=record.fencing_counter,
            )
            record.active_lease = lease
            self._transition(record, TaskStatus.LEASED, "exclusive lease acquired")
            self._event(record, "LEASE_ACQUIRED", attemptId=attempt_id, leaseId=lease.lease_id, workerId=worker_id, fencingToken=lease.fencing_token, expiresAt=lease.lease_expires_at.isoformat())
            return lease

        response = self._mutate(key, mutation)
        if isinstance(response, _RejectedMutation):
            raise CoordinatorError(response.message)
        return response

    def _assert_fence(self, record: TaskRecord, lease_id: str, fencing_token: int, *, allow_expired: bool = False) -> Lease:
        lease = record.active_lease
        if lease is None or lease.lease_id != lease_id or lease.fencing_token != fencing_token:
            raise StaleFenceError("lease is absent or fencing token is stale")
        if not allow_expired and lease.lease_expires_at <= self.clock():
            raise StaleFenceError("lease has expired")
        return lease

    def renew(self, task_id: str, task_version: int, lease_id: str, fencing_token: int, ttl_seconds: int) -> Lease:
        if ttl_seconds < 1:
            raise CoordinatorError("lease TTL must be positive")
        key = self._key(task_id, task_version)

        def mutation(record: TaskRecord) -> Lease:
            lease = self._assert_fence(record, lease_id, fencing_token)
            lease.lease_expires_at = self.clock() + timedelta(seconds=ttl_seconds)
            self._event(record, "LEASE_RENEWED", leaseId=lease_id, fencingToken=fencing_token, expiresAt=lease.lease_expires_at.isoformat())
            return lease

        return self._mutate(key, mutation)

    def begin_verification(self, task_id: str, task_version: int, lease_id: str, fencing_token: int) -> TaskRecord:
        key = self._key(task_id, task_version)

        def mutation(record: TaskRecord) -> TaskRecord:
            self._assert_fence(record, lease_id, fencing_token)
            self._transition(record, TaskStatus.VERIFYING, "isolated verification started")
            return record

        return self._mutate(key, mutation)

    def record_qualification_checkpoint(
        self,
        task_id: str,
        task_version: int,
        lease_id: str,
        fencing_token: int,
        checks: Mapping[str, bool],
    ) -> TaskRecord:
        expected = {"VMQ-RUNAWAY-TERMINATION", "VMQ-CONTAINER-CLEANUP"}
        if set(checks) != expected or any(type(value) is not bool for value in checks.values()):
            raise CoordinatorError("qualification checkpoint fields are invalid")
        key = self._key(task_id, task_version)

        def mutation(record: TaskRecord) -> TaskRecord:
            self._assert_fence(record, lease_id, fencing_token)
            if record.status != TaskStatus.VERIFYING:
                raise CoordinatorError("qualification checkpoint requires VERIFYING state")
            self._event(
                record,
                "QUALIFICATION_CHECKPOINT",
                attemptId=record.active_lease.attempt_id if record.active_lease else None,
                leaseId=lease_id,
                fencingToken=fencing_token,
                checks=dict(checks),
            )
            return record

        return self._mutate(key, mutation)

    def retrieve_github_ci_evidence(
        self,
        task_id: str,
        task_version: int,
        lease_id: str,
        fencing_token: int,
        commit_sha: str,
        criteria: Sequence[str],
        reader: GitHubEvidenceReader,
    ) -> TrustedEvidence:
        key = self._key(task_id, task_version)
        snapshot = self.store.get(key).value
        self._assert_fence(snapshot, lease_id, fencing_token)
        if snapshot.status != TaskStatus.VERIFYING:
            raise CoordinatorError("trusted CI evidence can only be retrieved while VERIFYING")
        if commit_sha not in snapshot.task["commitRefs"]:
            raise CoordinatorError("trusted CI evidence commit is not bound to the Build Task")
        if not criteria or not set(criteria).issubset(set(snapshot.task["acceptanceCriteria"])):
            raise CoordinatorError("trusted CI evidence criteria are not bound to the Build Task")
        evidence = retrieve_github_ci_evidence(reader, snapshot.task["repository"], commit_sha, criteria)

        def mutation(record: TaskRecord) -> TaskRecord:
            self._assert_fence(record, lease_id, fencing_token)
            if record.status != TaskStatus.VERIFYING or record.task_fingerprint != snapshot.task_fingerprint:
                raise CoordinatorError("task changed while trusted CI evidence was retrieved")
            self._event(
                record,
                "TRUSTED_EVIDENCE_RETRIEVED",
                evidenceRef=evidence.evidence_ref,
                kind=evidence.kind,
                source=evidence.source,
                commitSha=commit_sha,
                criteria=list(criteria),
            )
            return record

        self._mutate(key, mutation)
        return evidence

    def complete_attempt(
        self,
        task_id: str,
        task_version: int,
        candidate: Mapping[str, Any],
        lease_id: str,
        fencing_token: int,
        *,
        trusted_evidence: Sequence[TrustedEvidence] = (),
    ) -> TaskRecord:
        key = self._key(task_id, task_version)

        def mutation(record: TaskRecord) -> TaskRecord:
            attempt_id = candidate.get("attemptId")
            existing = next((item for item in record.results if item.get("attemptId") == attempt_id), None)
            if existing is not None:
                lease_for_normalization = record.active_lease
                if lease_for_normalization is None:
                    class CompletedLease:
                        pass
                    lease_for_normalization = CompletedLease()
                    lease_for_normalization.attempt_id = attempt_id
                    lease_for_normalization.worker_id = existing["workerIdentity"]
                    lease_for_normalization.lease_id = existing["leaseId"]
                    lease_for_normalization.fencing_token = existing["fencingToken"]
                normalized = normalize_and_validate_result(
                    candidate,
                    record.task,
                    lease_for_normalization,
                    self.config,
                    trusted_evidence=trusted_evidence,
                )
                if canonical_json(existing) != canonical_json(normalized):
                    raise CoordinatorError("conflicting result for deterministic attempt identity")
                return _NoWrite(record)
            lease = self._assert_fence(record, lease_id, fencing_token)
            if record.status != TaskStatus.VERIFYING:
                raise CoordinatorError("result can only be ingested while VERIFYING")
            if candidate.get("result") == "PARTNER_DECISION_REQUIRED":
                raise CoordinatorError("untrusted verification result cannot raise a Partner Decision")
            normalized = normalize_and_validate_result(
                candidate, record.task, lease, self.config, trusted_evidence=trusted_evidence
            )
            disposition = normalized["result"]
            if disposition == "PARTNER_DECISION_REQUIRED":
                raise CoordinatorError("untrusted verification result cannot raise a Partner Decision")
            target = {
                "PASS": TaskStatus.READY_FOR_PM_ACCEPTANCE,
                "FAIL": TaskStatus.REWORK_REQUIRED,
            }[disposition]
            record.results.append(normalized)
            if disposition != "PASS":
                record.failure_history.append({"attemptId": lease.attempt_id, "disposition": disposition, "at": self.clock().isoformat()})
            self._transition(record, target, f"validated normalized result: {disposition}")
            self._event(record, "RESULT_INGESTED", attemptId=lease.attempt_id, result=disposition, resultFingerprint=fingerprint(normalized))
            record.active_lease = None
            return record

        return self._mutate(key, mutation)

    def raise_partner_decision(self, task_id: str, task_version: int, reason: str, lease_id: str, fencing_token: int) -> TaskRecord:
        normalized_reason = reason.strip().lower()
        if normalized_reason not in _RESERVED_PARTNER_GATE_REASONS:
            raise CoordinatorError("reason is not a reserved Partner Decision matter")
        key = self._key(task_id, task_version)

        def mutation(record: TaskRecord) -> TaskRecord:
            lease = self._assert_fence(record, lease_id, fencing_token)
            if record.status != TaskStatus.VERIFYING:
                raise CoordinatorError("Partner Decision can only be raised while VERIFYING")
            now = self.clock().isoformat()
            evidence_reference = f"audit://{record.key}/partner-gate/{lease.attempt_id}"
            trusted_evidence = coordinator_observation_evidence(
                evidence_ref=evidence_reference,
                kind="partner-gate",
                source=evidence_reference,
                result="PARTNER_DECISION_REQUIRED",
                criteria=record.task["acceptanceCriteria"],
                details={"reservedMatter": normalized_reason},
            )
            candidate = {
                "schemaVersion": "1.0", "taskId": record.task["taskId"], "attemptId": lease.attempt_id,
                "HermesVersion": self.config.hermes_version, "configFingerprint": self.config.fingerprint,
                "workerIdentity": lease.worker_id, "leaseId": lease.lease_id, "fencingToken": lease.fencing_token,
                "specificationRef": record.task["specificationRef"], "specificationHash": record.task["specificationHash"],
                "acceptanceContractRef": record.task["acceptanceContractRef"],
                "acceptanceContractHash": record.task["acceptanceContractHash"],
                "repository": record.task["repository"], "baseRef": record.task["baseRef"],
                "branchRef": record.task["branchRef"], "prRef": record.task["prRef"],
                "commitRefs": record.task["commitRefs"],
                "deterministicEvidence": [],
                "semanticEvidence": [],
                "acceptanceCriteriaResults": [
                    {"criterion": criterion, "result": "PARTNER_DECISION_REQUIRED", "evidenceRefs": [evidence_reference]}
                    for criterion in record.task["acceptanceCriteria"]
                ],
                "result": "PARTNER_DECISION_REQUIRED", "residualRisks": [normalized_reason],
                "retryInformation": {"eligible": False, "reason": "reserved-matter"},
                "timestamps": {"startedAt": lease.lease_started_at.isoformat(), "completedAt": now},
                "auditReferences": [evidence_reference],
            }
            normalized = normalize_and_validate_result(
                candidate, record.task, lease, self.config, trusted_evidence=[trusted_evidence]
            )
            record.results.append(normalized)
            record.failure_history.append(
                {"attemptId": lease.attempt_id, "disposition": "PARTNER_DECISION_REQUIRED", "at": now}
            )
            self._transition(record, TaskStatus.PARTNER_DECISION_REQUIRED, normalized_reason)
            self._event(
                record, "RESULT_INGESTED", attemptId=lease.attempt_id,
                result="PARTNER_DECISION_REQUIRED", resultFingerprint=fingerprint(normalized),
            )
            record.active_lease = None
            return record

        return self._mutate(key, mutation)

    def recover(self, task_id: str, task_version: int) -> TaskRecord:
        key = self._key(task_id, task_version)

        def mutation(record: TaskRecord) -> TaskRecord:
            lease = record.active_lease
            if lease is None or lease.lease_expires_at > self.clock():
                self._event(record, "RECOVERY_INSPECTED", outcome="no expired lease")
                return record
            if record.status == TaskStatus.LEASED:
                self._transition(record, TaskStatus.READY, "expired lease recovered before verification")
            elif record.status == TaskStatus.VERIFYING:
                self._transition(record, TaskStatus.REWORK_REQUIRED, "ambiguous partial verification requires reconciliation")
                record.failure_history.append({"attemptId": lease.attempt_id, "disposition": "AMBIGUOUS_PARTIAL_STATE", "at": self.clock().isoformat()})
            else:
                raise CoordinatorError(f"expired active lease is inconsistent with {record.status.value}")
            self._event(record, "LEASE_EXPIRED", leaseId=lease.lease_id, fencingToken=lease.fencing_token)
            record.active_lease = None
            return record

        return self._mutate(key, mutation)

    def health(self) -> dict[str, Any]:
        dependency_status = "HEALTHY"
        try:
            records = [versioned.value for versioned in self.store.list_records()]
        except Exception:
            records = []
            dependency_status = "UNHEALTHY"
        current = next((record for record in records if record.active_lease is not None), None)
        successes = [record for record in records if record.status == TaskStatus.READY_FOR_PM_ACCEPTANCE]
        failures = [record for record in records if record.status in {TaskStatus.REWORK_REQUIRED, TaskStatus.FAILED}]
        pending = sum(record.status in {TaskStatus.READY, TaskStatus.REWORK_REQUIRED} for record in records)
        return {
            "hermesVersion": self.config.hermes_version,
            "configurationFingerprint": self.config.fingerprint,
            "environmentIdentity": self.config.environment_id,
            "workerIdentity": self.config.worker_identity,
            "lastHeartbeat": self.clock().isoformat(),
            "currentTask": current.task["taskId"] if current else None,
            "currentLease": {
                "leaseId": current.active_lease.lease_id,
                "fencingToken": current.active_lease.fencing_token,
                "expiresAt": current.active_lease.lease_expires_at.isoformat(),
            } if current and current.active_lease else None,
            "pendingTaskVisibility": pending,
            "lastSuccessfulTask": successes[-1].task["taskId"] if successes else None,
            "lastFailedTask": failures[-1].task["taskId"] if failures else None,
            "dependencyHealth": {"stateStore": dependency_status},
        }
