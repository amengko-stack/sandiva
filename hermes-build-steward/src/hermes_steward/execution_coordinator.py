from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Mapping

from .execution_contracts import (
    ExecutionContractError,
    ExecutorProfile,
    ExecutorProfileRegistry,
    NormalizedExecutionRequest,
    validate_execution_result,
)
from .execution_publisher import PublicationRecord
from .prepublication import ChangeSet
from .store import InMemoryStateStore, RecordNotFound, StateStore, StoreConflict


class RecoveryError(RuntimeError):
    pass


class ExecutionStage(str, Enum):
    CREATED = "CREATED"
    WORKSPACE_READY = "WORKSPACE_READY"
    EXECUTOR_STARTED = "EXECUTOR_STARTED"
    IMPLEMENTED = "IMPLEMENTED"
    CHANGESET_APPROVED = "CHANGESET_APPROVED"
    PUBLISHED = "PUBLISHED"
    RESULT_PERSISTED = "RESULT_PERSISTED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class ExecutionRecord:
    identity: str
    task_fingerprint: str
    attempt_id: str
    stage: ExecutionStage
    revision: int = 0
    workspace: str | None = None
    execution_result: Mapping[str, Any] | None = None
    change_set: ChangeSet | None = None
    publication: PublicationRecord | None = None
    failure_classification: str | None = None
    audit: tuple[str, ...] = ()


class CasExecutionRecordStore:
    """Execution-record adapter over Hermes' production-capable CAS store contract."""

    def __init__(self, store: StateStore[ExecutionRecord]):
        self._store = store

    def load(self, identity: str) -> ExecutionRecord | None:
        try:
            return self._store.get(identity).value
        except RecordNotFound:
            return None

    def put_if_absent(self, record: ExecutionRecord) -> ExecutionRecord:
        try:
            return self._store.create(record.identity, record).value
        except StoreConflict:
            current = self._store.get(record.identity).value
            if current.task_fingerprint != record.task_fingerprint or current.attempt_id != record.attempt_id:
                raise RecoveryError("conflicting duplicate execution identity")
            return current

    def save(self, record: ExecutionRecord, expected_revision: int) -> ExecutionRecord:
        try:
            current = self._store.get(record.identity)
        except RecordNotFound as error:
            raise RecoveryError("execution record disappeared") from error
        if current.value.revision != expected_revision:
            raise RecoveryError("execution record CAS conflict")
        updated = replace(record, revision=expected_revision + 1)
        try:
            return self._store.compare_and_swap(record.identity, current.etag, updated).value
        except StoreConflict as error:
            raise RecoveryError("execution record CAS conflict") from error

    def attempt_count(self, task_fingerprint: str) -> int:
        return sum(item.value.task_fingerprint == task_fingerprint for item in self._store.list_records())


class InMemoryExecutionRecordStore(CasExecutionRecordStore):
    """Thread-safe in-memory CAS binding for deterministic tests only."""

    def __init__(self):
        super().__init__(InMemoryStateStore())


def execution_identity(request: NormalizedExecutionRequest) -> str:
    return f"exec:{request.task_fingerprint}:{request.attempt_id}"


def execution_record_to_dict(record: ExecutionRecord) -> dict[str, Any]:
    return {
        "identity": record.identity,
        "taskFingerprint": record.task_fingerprint,
        "attemptId": record.attempt_id,
        "stage": record.stage.value,
        "revision": record.revision,
        "workspace": record.workspace,
        "executionResult": dict(record.execution_result) if record.execution_result is not None else None,
        "changeSet": None if record.change_set is None else {
            "changedPaths": list(record.change_set.changed_paths),
            "patchDigest": record.change_set.patch_digest,
            "totalBytes": record.change_set.total_bytes,
            "binaryPaths": list(record.change_set.binary_paths),
            "generatedPaths": list(record.change_set.generated_paths),
        },
        "publication": None if record.publication is None else {
            "branch": record.publication.branch,
            "commitSha": record.publication.commit_sha,
            "draftPr": dict(record.publication.draft_pr),
            "prIdentity": record.publication.pr_identity,
        },
        "failureClassification": record.failure_classification,
        "audit": list(record.audit),
    }


def execution_record_from_dict(raw: Mapping[str, Any]) -> ExecutionRecord:
    expected = {
        "identity", "taskFingerprint", "attemptId", "stage", "revision", "workspace",
        "executionResult", "changeSet", "publication", "failureClassification", "audit",
    }
    if not isinstance(raw, Mapping) or set(raw) != expected:
        raise RecoveryError("persisted execution record fields are invalid")
    try:
        stage = ExecutionStage(raw["stage"])
    except (TypeError, ValueError) as error:
        raise RecoveryError("persisted execution stage is invalid") from error
    if not isinstance(raw["revision"], int) or isinstance(raw["revision"], bool) or raw["revision"] < 0:
        raise RecoveryError("persisted execution revision is invalid")
    if not isinstance(raw["identity"], str) or not raw["identity"].startswith("exec:"):
        raise RecoveryError("persisted execution identity is invalid")
    if not isinstance(raw["taskFingerprint"], str) or not re.fullmatch(r"[0-9a-f]{64}", raw["taskFingerprint"]):
        raise RecoveryError("persisted execution taskFingerprint is invalid")
    if not isinstance(raw["attemptId"], str) or not raw["attemptId"]:
        raise RecoveryError("persisted execution attemptId is invalid")
    if raw["identity"] != f"exec:{raw['taskFingerprint']}:{raw['attemptId']}":
        raise RecoveryError("persisted execution identity binding is invalid")
    if raw["workspace"] is not None and not isinstance(raw["workspace"], str):
        raise RecoveryError("persisted execution workspace is invalid")
    if raw["executionResult"] is not None and not isinstance(raw["executionResult"], Mapping):
        raise RecoveryError("persisted execution result is invalid")
    if raw["failureClassification"] is not None and not isinstance(raw["failureClassification"], str):
        raise RecoveryError("persisted execution failure classification is invalid")
    if not isinstance(raw["audit"], list) or any(not isinstance(item, str) for item in raw["audit"]):
        raise RecoveryError("persisted execution audit is invalid")
    change_raw = raw["changeSet"]
    changes = None
    if change_raw is not None:
        if not isinstance(change_raw, Mapping) or set(change_raw) != {
            "changedPaths", "patchDigest", "totalBytes", "binaryPaths", "generatedPaths",
        }:
            raise RecoveryError("persisted change set is invalid")
        if (
            not isinstance(change_raw["changedPaths"], list)
            or not isinstance(change_raw["binaryPaths"], list)
            or not isinstance(change_raw["generatedPaths"], list)
            or not isinstance(change_raw["patchDigest"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", change_raw["patchDigest"])
            or not isinstance(change_raw["totalBytes"], int)
            or isinstance(change_raw["totalBytes"], bool)
            or change_raw["totalBytes"] < 0
        ):
            raise RecoveryError("persisted change set values are invalid")
        changes = ChangeSet(
            tuple(change_raw["changedPaths"]), change_raw["patchDigest"], change_raw["totalBytes"],
            tuple(change_raw["binaryPaths"]), tuple(change_raw["generatedPaths"]),
        )
    publication_raw = raw["publication"]
    publication = None
    if publication_raw is not None:
        if not isinstance(publication_raw, Mapping) or set(publication_raw) != {
            "branch", "commitSha", "draftPr", "prIdentity",
        }:
            raise RecoveryError("persisted publication is invalid")
        if (
            not isinstance(publication_raw["branch"], str)
            or not isinstance(publication_raw["commitSha"], str)
            or not re.fullmatch(r"[0-9a-f]{40}", publication_raw["commitSha"])
            or not isinstance(publication_raw["draftPr"], Mapping)
            or not isinstance(publication_raw["prIdentity"], str)
        ):
            raise RecoveryError("persisted publication values are invalid")
        publication = PublicationRecord(
            publication_raw["branch"], publication_raw["commitSha"],
            dict(publication_raw["draftPr"]), publication_raw["prIdentity"],
        )
    return ExecutionRecord(
        identity=raw["identity"], task_fingerprint=raw["taskFingerprint"], attempt_id=raw["attemptId"],
        stage=stage, revision=raw["revision"], workspace=raw["workspace"],
        execution_result=copy.deepcopy(raw["executionResult"]), change_set=changes,
        publication=publication, failure_classification=raw["failureClassification"],
        audit=tuple(raw["audit"]),
    )


def build_execution_audit_record(
    request: NormalizedExecutionRequest,
    record: ExecutionRecord,
    *,
    max_bytes: int = 32768,
) -> dict[str, Any]:
    if record.stage != ExecutionStage.RESULT_PERSISTED or record.publication is None or record.execution_result is None:
        raise RecoveryError("only a durably persisted execution can produce a final audit record")
    value = {
        "schemaVersion": "1.0",
        "auditProvenanceId": request.audit_provenance_id,
        "pmInstruction": {
            "ref": request.originating_pm_instruction_ref,
            "fingerprint": request.originating_pm_instruction_fingerprint,
        },
        "task": {
            "id": request.task_id,
            "version": request.task_version,
            "fingerprint": request.task_fingerprint,
        },
        "specification": {
            "ref": request.specification_ref,
            "version": request.specification_version,
            "hash": request.specification_hash,
        },
        "acceptanceContract": {
            "ref": request.acceptance_contract_ref,
            "version": request.acceptance_contract_version,
            "hash": request.acceptance_contract_hash,
        },
        "repository": {"url": request.repository, "baseSha": request.base_sha},
        "authority": {
            "permittedRepositoryAreas": list(request.permitted_repository_areas),
            "prohibitedRepositoryAreas": list(request.prohibited_repository_areas),
            "permissionEnvelopeRef": request.permission_envelope_ref,
            "networkPolicyRef": request.network_policy_ref,
            "resourcePolicyRef": request.resource_policy_ref,
            "publisherPolicyRef": request.publisher_policy_ref,
            "retryPolicy": json.loads(request.retry_policy_json),
            "fallbackPolicy": json.loads(request.fallback_policy_json),
        },
        "executor": {
            "profileId": request.executor_profile_id,
            "profileFingerprint": request.executor_profile_fingerprint,
            "provider": request.executor_provider,
            "observedIdentity": json.loads(request.observed_executor_identity_json),
            "fallbackContext": json.loads(request.fallback_context_json),
        },
        "attempt": {
            "attemptId": request.attempt_id,
            "leaseId": request.lease_id,
            "fencingToken": request.fencing_token,
            "stages": list(record.audit),
        },
        "publication": {
            "branch": record.publication.branch,
            "commitSha": record.publication.commit_sha,
            "draftPr": {
                "number": record.publication.draft_pr["number"],
                "url": record.publication.draft_pr["url"],
                "isDraft": True,
            },
            "patchDigest": record.change_set.patch_digest if record.change_set else None,
        },
        "result": {
            "disposition": record.execution_result["disposition"],
            "acceptanceDisposition": record.execution_result["acceptanceDisposition"],
            "failureClassification": record.execution_result["failureClassification"],
            "evidenceReferences": list(record.execution_result["evidenceReferences"]),
        },
    }
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > max_bytes:
        raise RecoveryError("execution audit record exceeds its configured size limit")
    lowered = encoded.lower()
    for prohibited in (b"credential", b"privatekey", b"accesstoken", b"refreshtoken", b"password"):
        if prohibited in lowered:
            raise RecoveryError("execution audit record contains a prohibited secret field")
    return value


def select_executor_profile(
    task: Mapping[str, Any],
    registry: ExecutorProfileRegistry,
    unavailable_profile_ids: set[str] | frozenset[str],
) -> ExecutorProfile:
    policy = task.get("dispatchPolicy")
    if not isinstance(policy, Mapping):
        raise RecoveryError("dispatch policy is required")
    if policy.get("noDowngrade") is not True:
        raise RecoveryError("executor downgrade is forbidden")
    primary = policy.get("executorProfile")
    fallbacks = policy.get("permittedFallbackProfiles")
    if not isinstance(primary, Mapping) or not isinstance(fallbacks, list):
        raise RecoveryError("executor profile policy is malformed")
    references = [primary]
    if primary.get("profileId") in unavailable_profile_ids:
        if policy.get("fallbackMode") != "ORDERED":
            raise RecoveryError("no authorized executor is available")
        references.extend(fallbacks)
    for reference in references:
        profile_id = reference.get("profileId")
        profile_fingerprint = reference.get("profileFingerprint")
        if profile_id in unavailable_profile_ids:
            continue
        try:
            return registry.resolve(profile_id, profile_fingerprint)
        except ExecutionContractError as error:
            raise RecoveryError(str(error)) from error
    raise RecoveryError("no authorized executor is available")


class ExecutionCoordinator:
    """Checkpointed execution state machine below Hermes lease/fence authority."""

    def __init__(
        self,
        store: Any,
        workspace_factory: Any,
        adapter: Any,
        inspector: Any,
        publisher: Any,
        result_sink: Any,
        assert_current_authority: Callable[[], None],
        *,
        source_repository: Path,
    ):
        self._store = store
        self._workspace_factory = workspace_factory
        self._adapter = adapter
        self._inspector = inspector
        self._publisher = publisher
        self._result_sink = result_sink
        self._assert_current_authority = assert_current_authority
        self._source_repository = source_repository.resolve()
        if not self._source_repository.is_dir():
            raise RecoveryError("trusted source repository is unavailable")

    @staticmethod
    def _checkpoint(record: ExecutionRecord, stage: ExecutionStage, **changes: Any) -> ExecutionRecord:
        audit = (*record.audit, stage.value)
        return replace(record, stage=stage, audit=audit, **changes)

    def _save(self, prior: ExecutionRecord, updated: ExecutionRecord) -> ExecutionRecord:
        return self._store.save(updated, prior.revision)

    @staticmethod
    def _max_attempts(request: NormalizedExecutionRequest) -> int:
        try:
            value = json.loads(request.retry_policy_json)["maxAttempts"]
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise RecoveryError("retry policy is invalid") from error
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise RecoveryError("retry policy is invalid")
        return value

    def dispatch(self, request: NormalizedExecutionRequest, *, crash_after: str | None = None) -> ExecutionRecord:
        identity = execution_identity(request)
        current = self._store.load(identity)
        if current is None:
            if self._store.attempt_count(request.task_fingerprint) >= self._max_attempts(request):
                raise RecoveryError("retry limit exhausted")
            current = self._store.put_if_absent(ExecutionRecord(
                identity=identity,
                task_fingerprint=request.task_fingerprint,
                attempt_id=request.attempt_id,
                stage=ExecutionStage.CREATED,
                audit=(ExecutionStage.CREATED.value,),
            ))
        elif current.task_fingerprint != request.task_fingerprint or current.attempt_id != request.attempt_id:
            raise RecoveryError("conflicting duplicate execution identity")
        completed = self._run(request, current, crash_after)
        self._cleanup_terminal(completed)
        return completed

    def resume(self, request: NormalizedExecutionRequest) -> ExecutionRecord:
        current = self._store.load(execution_identity(request))
        if current is None:
            raise RecoveryError("execution record does not exist")
        if current.stage == ExecutionStage.EXECUTOR_STARTED:
            failed = self._checkpoint(
                current,
                ExecutionStage.FAILED,
                failure_classification="AMBIGUOUS_EXECUTOR_STATE",
            )
            completed = self._save(current, failed)
            self._cleanup_terminal(completed)
            return completed
        completed = self._run(request, current, None)
        self._cleanup_terminal(completed)
        return completed

    def cancel(self, request: NormalizedExecutionRequest) -> ExecutionRecord:
        current = self._store.load(execution_identity(request))
        if current is None:
            raise RecoveryError("execution record does not exist")
        if current.stage in {ExecutionStage.RESULT_PERSISTED, ExecutionStage.FAILED, ExecutionStage.CANCELLED}:
            return current
        self._assert_current_authority()
        completed = self._save(current, self._checkpoint(current, ExecutionStage.CANCELLED, failure_classification="CANCELLED"))
        self._cleanup_terminal(completed)
        return completed

    def _cleanup_terminal(self, record: ExecutionRecord) -> None:
        if record.stage not in {ExecutionStage.RESULT_PERSISTED, ExecutionStage.FAILED, ExecutionStage.CANCELLED}:
            return
        destroy = getattr(self._workspace_factory, "destroy", None)
        if callable(destroy) and record.workspace is not None:
            destroy(record.workspace)

    @staticmethod
    def _crash(point: str | None, current: str) -> None:
        if point == current:
            raise RecoveryError(f"injected crash after {current}")

    def _run(
        self,
        request: NormalizedExecutionRequest,
        record: ExecutionRecord,
        crash_after: str | None,
    ) -> ExecutionRecord:
        while record.stage not in {
            ExecutionStage.RESULT_PERSISTED,
            ExecutionStage.FAILED,
            ExecutionStage.CANCELLED,
        }:
            if record.stage == ExecutionStage.CREATED:
                self._assert_current_authority()
                workspace = self._workspace_factory.create(request, self._source_repository)
                updated = self._checkpoint(record, ExecutionStage.WORKSPACE_READY, workspace=str(workspace.path))
                record = self._save(record, updated)
                self._crash(crash_after, "WORKSPACE_READY")
                continue

            if record.stage == ExecutionStage.WORKSPACE_READY:
                self._assert_current_authority()
                started = self._checkpoint(record, ExecutionStage.EXECUTOR_STARTED)
                record = self._save(record, started)
                try:
                    raw = self._adapter.execute(request, record.workspace)
                except BaseException:
                    # EXECUTOR_STARTED persists; restart reconciliation treats it as ambiguous.
                    raise
                try:
                    result = validate_execution_result(raw, request)
                except ExecutionContractError:
                    failed = self._checkpoint(
                        record, ExecutionStage.FAILED,
                        failure_classification="MALFORMED_PROVIDER_RESULT",
                    )
                    return self._save(record, failed)
                implemented = self._checkpoint(record, ExecutionStage.IMPLEMENTED, execution_result=result)
                record = self._save(record, implemented)
                self._crash(crash_after, "IMPLEMENTED")
                continue

            if record.stage == ExecutionStage.IMPLEMENTED:
                assert record.execution_result is not None
                if record.execution_result["disposition"] != "EXECUTION_SUCCEEDED":
                    failed = self._checkpoint(
                        record, ExecutionStage.FAILED,
                        failure_classification=record.execution_result["failureClassification"],
                    )
                    return self._save(record, failed)
                self._assert_current_authority()
                changes = self._inspector.inspect(record.workspace, request)
                approved = self._checkpoint(record, ExecutionStage.CHANGESET_APPROVED, change_set=changes)
                record = self._save(record, approved)
                continue

            if record.stage == ExecutionStage.CHANGESET_APPROVED:
                assert record.change_set is not None and record.workspace is not None
                self._assert_current_authority()
                current_changes = self._inspector.inspect(record.workspace, request)
                if current_changes != record.change_set:
                    raise RecoveryError("workspace changed after approval")
                publication = self._publisher.publish_draft(
                    request, record.change_set, record.workspace, self._assert_current_authority
                )
                published = self._checkpoint(record, ExecutionStage.PUBLISHED, publication=publication)
                record = self._save(record, published)
                continue

            if record.stage == ExecutionStage.PUBLISHED:
                assert record.execution_result is not None and record.publication is not None
                self._assert_current_authority()
                durable = dict(record.execution_result)
                durable.update(
                    changedPaths=list(record.change_set.changed_paths) if record.change_set is not None else [],
                    patchDigest=record.change_set.patch_digest if record.change_set is not None else None,
                    branch=record.publication.branch,
                    commitSha=record.publication.commit_sha,
                    draftPr={
                        "number": record.publication.draft_pr["number"],
                        "url": record.publication.draft_pr["url"],
                        "isDraft": True,
                    },
                )
                validate_execution_result(durable, request, allow_trusted_publication=True)
                self._result_sink.put(record.identity, durable)
                persisted = self._checkpoint(record, ExecutionStage.RESULT_PERSISTED, execution_result=durable)
                record = self._save(record, persisted)
                continue

            raise RecoveryError(f"unsupported execution stage: {record.stage}")
        return record
