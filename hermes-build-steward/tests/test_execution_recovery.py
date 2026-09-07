from __future__ import annotations

import unittest
from dataclasses import replace
from types import SimpleNamespace

from hermes_steward.execution_contracts import ExecutorProfileRegistry
from hermes_steward.execution_coordinator import (
    build_execution_audit_record,
    CasExecutionRecordStore,
    execution_record_from_dict,
    execution_record_to_dict,
    ExecutionCoordinator,
    ExecutionStage,
    InMemoryExecutionRecordStore,
    RecoveryError,
    select_executor_profile,
)
from hermes_steward.execution_publisher import TrustedGitHubPublisher
from hermes_steward.prepublication import ChangeSet
from hermes_steward.sharepoint_store import SharePointListStateStore
from test_execution_adapters import profile, request_for
from test_execution_publisher import InMemoryGitHubGateway
from test_sharepoint_store import FakeGraphTransport


class Crash(RuntimeError):
    pass


class WorkspaceFactory:
    def __init__(self):
        self.calls = 0

    def create(self, request, source_repository):
        del source_repository
        self.calls += 1
        return SimpleNamespace(path=f"/workspace/{request.attempt_id}")


class Adapter:
    def __init__(self, result, *, crash=False):
        self.result = result
        self.crash = crash
        self.calls = 0

    def execute(self, request, workspace):
        del request, workspace
        self.calls += 1
        if self.crash:
            raise Crash("executor died")
        return dict(self.result)


class Inspector:
    def __init__(self):
        self.calls = 0

    def inspect(self, workspace, request):
        del workspace, request
        self.calls += 1
        return ChangeSet(("hermes-build-steward/README.md",), "1" * 64, 10, (), ())


class ResultSink:
    def __init__(self):
        self.values = {}
        self.calls = 0
        self.crash_after_write = False

    def put(self, identity, value):
        self.calls += 1
        prior = self.values.setdefault(identity, value)
        if prior != value:
            raise RecoveryError("conflicting durable result")
        if self.crash_after_write:
            raise Crash("crash after durable result write")


def successful_result(request):
    return {
        "schemaVersion": "1.0", "disposition": "EXECUTION_SUCCEEDED",
        "acceptanceDisposition": "NOT_EVALUATED", "taskId": request.task_id,
        "taskVersion": request.task_version, "taskFingerprint": request.task_fingerprint,
        "attemptId": request.attempt_id,
        "executorProfile": {
            "profileId": request.executor_profile_id,
            "profileFingerprint": request.executor_profile_fingerprint,
            "provider": request.executor_provider,
        },
        "timestamps": {"startedAt": "2026-09-06T10:00:00Z", "completedAt": "2026-09-06T10:01:00Z"},
        "baseSha": request.base_sha, "changedPaths": ["hermes-build-steward/README.md"],
        "patchDigest": "1" * 64, "commandsExecuted": [], "testOutcomes": [],
        "branch": None, "commitSha": None, "draftPr": None,
        "evidenceReferences": ["evidence://exec-01/synthetic"], "failureClassification": "NONE",
        "provenance": {"runtimeName": "synthetic", "runtimeVersion": "1", "model": "synthetic",
                       "launcherVersion": "1", "profileFingerprint": request.executor_profile_fingerprint,
                       "observedExecutorIdentity": __import__("json").loads(request.observed_executor_identity_json)},
        "auditProvenanceId": request.audit_provenance_id,
    }


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.request = request_for(profile("codex"))
        self.store = InMemoryExecutionRecordStore()
        self.workspace = WorkspaceFactory()
        self.adapter = Adapter(successful_result(self.request))
        self.inspector = Inspector()
        self.gateway = InMemoryGitHubGateway()
        self.publisher = TrustedGitHubPublisher(self.gateway)
        self.sink = ResultSink()
        self.authority_checks = 0

    def authority(self):
        self.authority_checks += 1

    def coordinator(self):
        return ExecutionCoordinator(
            self.store, self.workspace, self.adapter, self.inspector,
            self.publisher, self.sink, self.authority,
            source_repository=__import__("pathlib").Path(__file__).parents[1],
        )

    def test_duplicate_delivery_creates_one_run_commit_branch_pr_and_result(self):
        first = self.coordinator().dispatch(self.request)
        second = self.coordinator().dispatch(self.request)
        self.assertEqual(first, second)
        self.assertEqual(first.stage, ExecutionStage.RESULT_PERSISTED)
        self.assertEqual(self.workspace.calls, 1)
        self.assertEqual(self.adapter.calls, 1)
        self.assertEqual((self.gateway.commit_calls, self.gateway.push_calls, self.gateway.pr_calls), (1, 1, 1))
        self.assertEqual(len(self.sink.values), 1)

    def test_crash_before_launch_and_after_implementation_resume_without_duplicate_run(self):
        for point, expected_calls in (("WORKSPACE_READY", 0), ("IMPLEMENTED", 1)):
            with self.subTest(point=point):
                self.setUp()
                with self.assertRaises(RuntimeError):
                    self.coordinator().dispatch(self.request, crash_after=point)
                record = self.coordinator().resume(self.request)
                self.assertEqual(record.stage, ExecutionStage.RESULT_PERSISTED)
                self.assertEqual(self.adapter.calls, expected_calls + (1 if point == "WORKSPACE_READY" else 0))
                self.assertEqual(self.gateway.pr_calls, 1)

    def test_crash_during_executor_is_ambiguous_and_never_assumed_successful(self):
        self.adapter = Adapter(successful_result(self.request), crash=True)
        with self.assertRaises(Crash):
            self.coordinator().dispatch(self.request)
        record = self.coordinator().resume(self.request)
        self.assertEqual(record.stage, ExecutionStage.FAILED)
        self.assertEqual(record.failure_classification, "AMBIGUOUS_EXECUTOR_STATE")
        self.assertEqual(self.adapter.calls, 1)
        self.assertEqual(self.gateway.push_calls, 0)

    def test_crashes_after_commit_push_pr_and_result_write_reconcile_idempotently(self):
        for point in ("AFTER_COMMIT", "AFTER_PUSH", "AFTER_PR", "AFTER_RESULT_WRITE"):
            with self.subTest(point=point):
                self.setUp()
                self.gateway.crash_point = point
                self.sink.crash_after_write = point == "AFTER_RESULT_WRITE"
                with self.assertRaises(RuntimeError):
                    self.coordinator().dispatch(self.request)
                self.gateway.crash_point = None
                self.sink.crash_after_write = False
                record = self.coordinator().resume(self.request)
                self.assertEqual(record.stage, ExecutionStage.RESULT_PERSISTED)
                self.assertEqual((self.gateway.commit_calls, self.gateway.push_calls, self.gateway.pr_calls), (1, 1, 1))
                self.assertEqual(len(self.sink.values), 1)

    def test_timeout_and_malformed_result_fail_closed_with_normalized_classification(self):
        timed = successful_result(self.request)
        timed.update(disposition="EXECUTION_TIMED_OUT", failureClassification="TIMEOUT")
        self.adapter = Adapter(timed)
        record = self.coordinator().dispatch(self.request)
        self.assertEqual((record.stage, record.failure_classification), (ExecutionStage.FAILED, "TIMEOUT"))
        self.setUp()
        malformed = successful_result(self.request)
        malformed["taskFingerprint"] = "0" * 64
        self.adapter = Adapter(malformed)
        record = self.coordinator().dispatch(self.request)
        self.assertEqual((record.stage, record.failure_classification), (ExecutionStage.FAILED, "MALFORMED_PROVIDER_RESULT"))
        self.assertEqual(self.gateway.push_calls, 0)

    def test_retry_count_is_task_bounded_and_new_attempt_must_be_explicit(self):
        failed = successful_result(self.request)
        failed.update(disposition="EXECUTION_FAILED", failureClassification="PROVIDER_UNAVAILABLE")
        self.adapter = Adapter(failed)
        self.coordinator().dispatch(self.request)
        for number in (2, 3):
            candidate = replace(self.request, attempt_id=f"attempt-exec-{number}", lease_id=f"lease-{number}", fencing_token=7 + number)
            self.adapter.result = {**failed, "attemptId": candidate.attempt_id}
            self.coordinator().dispatch(candidate)
        fourth = replace(self.request, attempt_id="attempt-exec-4", lease_id="lease-4", fencing_token=12)
        with self.assertRaisesRegex(RecoveryError, "retry limit"):
            self.coordinator().dispatch(fourth)

    def test_fallback_requires_exact_task_authorization_and_never_silent_downgrade(self):
        codex, claude = profile("codex"), profile("claude-code")
        registry = ExecutorProfileRegistry([codex, claude])
        task = {"dispatchPolicy": {
            "executorProfile": {"profileId": codex.profile_id, "profileFingerprint": codex.fingerprint},
            "permittedFallbackProfiles": [], "fallbackMode": "NONE", "noDowngrade": True,
        }}
        with self.assertRaisesRegex(RecoveryError, "no authorized executor"):
            select_executor_profile(task, registry, {codex.profile_id})
        task["dispatchPolicy"]["fallbackMode"] = "ORDERED"
        task["dispatchPolicy"]["permittedFallbackProfiles"] = [
            {"profileId": claude.profile_id, "profileFingerprint": claude.fingerprint}
        ]
        self.assertEqual(select_executor_profile(task, registry, {codex.profile_id}), claude)
        task["dispatchPolicy"]["noDowngrade"] = False
        with self.assertRaisesRegex(RecoveryError, "downgrade"):
            select_executor_profile(task, registry, {codex.profile_id})

    def test_stale_fence_before_result_commit_denies_durable_success(self):
        calls = 0

        def authority():
            nonlocal calls
            calls += 1
            if calls >= 7:
                raise RecoveryError("stale fence")

        self.authority = authority
        with self.assertRaisesRegex(RecoveryError, "stale fence"):
            self.coordinator().dispatch(self.request)
        self.assertEqual(len(self.sink.values), 0)

    def test_final_audit_record_is_complete_bounded_and_contains_no_secret_material(self):
        record = self.coordinator().dispatch(self.request)
        audit = build_execution_audit_record(self.request, record)
        rendered = __import__("json").dumps(audit, sort_keys=True)
        for value in (
            self.request.originating_pm_instruction_ref,
            self.request.task_fingerprint,
            self.request.specification_hash,
            self.request.acceptance_contract_hash,
            self.request.base_sha,
            self.request.executor_profile_fingerprint,
            self.request.attempt_id,
            record.publication.branch,
            record.publication.commit_sha,
            record.publication.draft_pr["url"],
        ):
            self.assertIn(str(value), rendered)
        for forbidden in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "PFX-SENTINEL"):
            self.assertNotIn(forbidden, rendered)

    def test_execution_record_codec_round_trips_durable_recovery_state(self):
        record = self.coordinator().dispatch(self.request)
        encoded = execution_record_to_dict(record)
        restored = execution_record_from_dict(encoded)
        self.assertEqual(restored, record)
        encoded["taskFingerprint"] = "forged"
        with self.assertRaisesRegex(RecoveryError, "taskFingerprint"):
            execution_record_from_dict(encoded)

    def test_r7_new_coordinator_resumes_through_external_sharepoint_cas_without_duplicate_side_effects(self):
        transport = FakeGraphTransport()
        options = {
            "transport": transport,
            "record_encoder": execution_record_to_dict,
            "record_decoder": execution_record_from_dict,
            "status_getter": lambda record: record.stage.value,
        }
        external = SharePointListStateStore(
            "https://graph.microsoft.com/v1.0/sites/site/lists/exec-state",
            "prod.executions", "hermes-prod-vm", lambda: "graph-token", **options,
        )
        self.store = CasExecutionRecordStore(external)
        completed = self.coordinator().dispatch(self.request)
        restarted = SharePointListStateStore(
            "https://graph.microsoft.com/v1.0/sites/site/lists/exec-state",
            "prod.executions", "hermes-prod-vm", lambda: "graph-token", **options,
        )
        self.store = CasExecutionRecordStore(restarted)
        recovered = self.coordinator().resume(self.request)
        self.assertEqual(recovered, completed)
        self.assertEqual(self.adapter.calls, 1)
        self.assertEqual((self.gateway.commit_calls, self.gateway.push_calls, self.gateway.pr_calls), (1, 1, 1))


if __name__ == "__main__":
    unittest.main()
