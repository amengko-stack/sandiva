from __future__ import annotations

import copy
import json
import unittest
import io
import shutil
import uuid
from pathlib import Path
from datetime import datetime, timedelta, timezone
from dataclasses import replace

from hermes_steward.codec import record_from_dict, record_to_dict
from hermes_steward.config import RuntimeConfig
from hermes_steward.contracts import ContractValidationError, fingerprint
from hermes_steward.coordinator import Coordinator, TaskRecord
from hermes_steward.state import TaskStatus
from hermes_steward.coordinator import CoordinatorError
from hermes_steward.sharepoint_store import SharePointListStateStore
from hermes_steward.store import InMemoryStateStore
from test_execution_task_contract import dispatch_task
from test_execution_adapters import profile
from test_exec01_third_rework import gateway_manifest
from hermes_steward.execution_gateway_service import BoundProviderProxy, GatewayPolicy, GatewayServiceDenied
from test_exec01_third_rework import authoritative_collector_fixture
import test_exec01_second_rework as second_rework
from hermes_steward.execution_runtime import ProductionExecutionService
from hermes_steward.execution_coordinator import ExecutionStage
from hermes_steward.execution_adapters import CodexExecutionAdapter, ClaudeCodeExecutionAdapter
from test_execution_adapters import request_for, SyntheticRunner
from qualification.run_exec01_vm_qualification import sign_evidence, verify_evidence
from test_exec01_vm_qualification import Exec01QualificationTests
from test_sharepoint_store import FakeGraphTransport


class _NoMutationTransport:
    def __init__(self):
        self.calls = []

    def request(self, method, url, headers, body=None):
        self.calls.append((method, url, headers, body))
        raise AssertionError("transport must not be reached for invalid persisted content")


class FourthReworkTaskPersistenceTests(unittest.TestCase):
    def _record(self, task=None):
        task = task or dispatch_task(taskId="Q28-V2-PERSISTED")
        config = RuntimeConfig.from_mapping({
            "environmentKind": "development", "runtimeRole": "local-development",
            "environmentId": "q28", "taskNamespace": "dev.exec01",
            "leaseDomain": "dev.exec01", "workerIdentity": "q28-worker",
            "hermesVersion": "0.2.0", "stateBackend": "memory-test-only",
            "stateEndpoint": "memory://q28", "resultMaxBytes": 65536,
        })
        return Coordinator(InMemoryStateStore(), config).submit_task(task)

    def test_q28_v2_task_record_round_trip_and_v1_semantics_unchanged(self):
        record = self._record()
        encoded = record_to_dict(record)
        decoded = record_from_dict(json.loads(json.dumps(encoded)))
        self.assertEqual(decoded.task, record.task)
        self.assertEqual(decoded.task_fingerprint, fingerprint(record.task))

        v1 = copy.deepcopy(record.task)
        v1.pop("dispatchPolicy")
        v1["schemaVersion"] = "1.0"
        v1["executorPolicy"] = {"automaticDispatch": False, "approvedCommands": v1["executorPolicy"]["approvedCommands"]}
        v1_record = self._record(v1)
        self.assertEqual(record_from_dict(record_to_dict(v1_record)).task["schemaVersion"], "1.0")

    def test_q30_malformed_or_mixed_version_fails_before_sharepoint_mutation(self):
        record = self._record()
        encoded = record_to_dict(record)
        encoded["task"]["schemaVersion"] = "1.0"
        with self.assertRaises(ContractValidationError):
            record_from_dict(encoded)

        transport = _NoMutationTransport()
        store = SharePointListStateStore(
            "https://graph.microsoft.com/v1.0/sites/site/lists/list",
            "prod.exec01.tasks", "prod", lambda: "token", transport=transport,
        )
        bad_record = copy.deepcopy(record)
        bad_record.task["schemaVersion"] = "1.0"
        with self.assertRaises(ContractValidationError):
            store.create(bad_record.key, bad_record)
        self.assertEqual(transport.calls, [])

    def test_q29_v2_sharepoint_create_get_cas_list_and_restart(self):
        transport = FakeGraphTransport()
        options = {"transport": transport}
        store = SharePointListStateStore(
            "https://graph.microsoft.com/v1.0/sites/site/lists/tasks",
            "dev.exec01.tasks", "q29", lambda: "graph-token", **options,
        )
        config = RuntimeConfig.from_mapping({
            "environmentKind":"development","runtimeRole":"local-development",
            "environmentId":"q29","taskNamespace":"dev.exec01.tasks",
            "leaseDomain":"dev.exec01","workerIdentity":"worker-q29",
            "hermesVersion":"0.2.0","stateBackend":"memory-test-only",
            "stateEndpoint":"memory://q29","resultMaxBytes":65536,
        })
        coordinator = Coordinator(store, config)
        task = dispatch_task(taskId="Q29-V2-SHAREPOINT")
        created = coordinator.submit_task(task)
        lease = coordinator.claim(task["taskId"], task["taskVersion"], "worker-q29", 30)
        restarted = Coordinator(SharePointListStateStore(
            "https://graph.microsoft.com/v1.0/sites/site/lists/tasks",
            "dev.exec01.tasks", "q29", lambda: "graph-token", **options,
        ), config)
        loaded = restarted.store.get(created.key).value
        self.assertEqual(loaded.task, task)
        self.assertEqual(loaded.active_lease, lease)
        self.assertEqual(restarted.store.list_records()[0].value.task_fingerprint, fingerprint(task))


class FourthReworkFallbackStateTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 7, tzinfo=timezone.utc)
        self.codex, self.claude = profile("codex"), profile("claude-code")
        self.claude = replace(self.claude, allowed_endpoints=self.codex.allowed_endpoints)
        self.task = dispatch_task(taskId="Q32-FALLBACK", retryPolicy={"maxAttempts": 3, "backoffSeconds": 0})
        self.task["dispatchPolicy"].update(
            executorProfile={"profileId": self.codex.profile_id, "profileFingerprint": self.codex.fingerprint},
            permittedFallbackProfiles=[{"profileId": self.claude.profile_id, "profileFingerprint": self.claude.fingerprint}],
            fallbackMode="ORDERED",
        )
        config = RuntimeConfig.from_mapping({
            "environmentKind": "development", "runtimeRole": "local-development",
            "environmentId": "q32", "taskNamespace": "dev.exec01",
            "leaseDomain": "dev.exec01", "workerIdentity": "q32-worker",
            "hermesVersion": "0.2.0", "stateBackend": "memory-test-only",
            "stateEndpoint": "memory://q32", "resultMaxBytes": 65536,
        })
        self.coordinator = Coordinator(InMemoryStateStore(), config, clock=lambda: self.now)
        self.coordinator.submit_task(self.task)

    def _unavailable_primary(self):
        lease = self.coordinator.claim(self.task["taskId"], self.task["taskVersion"], "worker", 10)
        self.coordinator.record_execution_unavailable(
            self.task["taskId"], self.task["taskVersion"], lease.lease_id,
            lease.fencing_token, self.codex.profile_id, self.codex.fingerprint,
        )
        return lease

    def test_q32_fallback_claim_consumes_pending_and_durably_selects_exact_profile(self):
        self._unavailable_primary()
        fallback = self.coordinator.claim_fallback(self.task["taskId"], self.task["taskVersion"], "worker", 10)
        record = self.coordinator.store.get(f"dev.exec01:{self.task['taskId']}:{self.task['taskVersion']}").value
        self.assertEqual(record.active_lease, fallback)
        self.assertIsNone(record.pending_fallback_profile_id)
        self.assertIsNone(record.pending_fallback_profile_fingerprint)
        self.assertEqual(record.active_executor_profile_id, self.claude.profile_id)
        self.assertEqual(record.active_executor_profile_fingerprint, self.claude.fingerprint)

    def test_q36_exhausted_fallback_is_terminal_and_duplicate_claim_creates_no_lease(self):
        self._unavailable_primary()
        fallback = self.coordinator.claim_fallback(self.task["taskId"], self.task["taskVersion"], "worker", 10)
        self.coordinator.record_execution_unavailable(
            self.task["taskId"], self.task["taskVersion"], fallback.lease_id,
            fallback.fencing_token, self.claude.profile_id, self.claude.fingerprint,
        )
        key = f"dev.exec01:{self.task['taskId']}:{self.task['taskVersion']}"
        before = self.coordinator.store.get(key).value
        self.assertEqual(before.status.value, "FAILED")
        self.assertIsNone(before.active_lease)
        with self.assertRaises(CoordinatorError):
            self.coordinator.claim_fallback(self.task["taskId"], self.task["taskVersion"], "worker", 10)
        after = self.coordinator.store.get(key).value
        self.assertEqual((after.attempt_count, after.fencing_counter), (2, 2))

    def test_q34_expired_fallback_lease_recovers_exact_fallback_without_primary_replay(self):
        self._unavailable_primary()
        first_fallback = self.coordinator.claim_fallback(
            self.task["taskId"], self.task["taskVersion"], "worker", 10
        )
        self.now += timedelta(seconds=11)
        recovered = self.coordinator.recover(self.task["taskId"], self.task["taskVersion"])
        self.assertIsNone(recovered.active_lease)
        self.assertEqual(recovered.pending_fallback_profile_fingerprint, self.claude.fingerprint)
        second_fallback = self.coordinator.claim_fallback(
            self.task["taskId"], self.task["taskVersion"], "worker", 10
        )
        current = self.coordinator.store.get(
            f"dev.exec01:{self.task['taskId']}:{self.task['taskVersion']}"
        ).value
        self.assertNotEqual(second_fallback.attempt_id, first_fallback.attempt_id)
        self.assertEqual(current.active_executor_profile_fingerprint, self.claude.fingerprint)
        self.assertEqual(current.unavailable_profile_fingerprints, [self.codex.fingerprint])

    def test_q33_fallback_selection_survives_leased_verifying_and_expired_recovery_states(self):
        self._unavailable_primary()
        fallback = self.coordinator.claim_fallback(
            self.task["taskId"], self.task["taskVersion"], "worker", 10
        )
        leased = self.coordinator.store.get(
            f"dev.exec01:{self.task['taskId']}:{self.task['taskVersion']}"
        ).value
        self.assertEqual(record_from_dict(record_to_dict(leased)).active_executor_profile_fingerprint, self.claude.fingerprint)
        verifying = self.coordinator.begin_verification(
            self.task["taskId"], self.task["taskVersion"], fallback.lease_id, fallback.fencing_token
        )
        self.assertEqual(verifying.status, TaskStatus.VERIFYING)
        self.assertEqual(verifying.active_executor_profile_fingerprint, self.claude.fingerprint)
        self.now += timedelta(seconds=11)
        recovered = self.coordinator.recover(self.task["taskId"], self.task["taskVersion"])
        self.assertEqual(recovered.status, TaskStatus.REWORK_REQUIRED)
        self.assertEqual(recovered.pending_fallback_profile_fingerprint, self.claude.fingerprint)

    def test_q35_expired_workspace_stage_is_reconciled_then_retried_without_duplicate_side_effect(self):
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]
        root.mkdir(parents=True)
        try:
            selected = profile("codex")
            task = dispatch_task(taskId="Q35", retryPolicy={"maxAttempts":3,"backoffSeconds":0})
            task["dispatchPolicy"].update(
                executorProfile={"profileId":selected.profile_id,"profileFingerprint":selected.fingerprint},
                permittedFallbackProfiles=[], fallbackMode="NONE",
            )
            class Runner:
                calls = 0
                def invoke(self, profile_value, request, workspace):
                    del profile_value, request
                    self.calls += 1
                    (Path(workspace)/"hermes-build-steward"/"README.md").write_text("recovered\n")
                    return {"protocol":"codex-exec-jsonl-v1","status":"completed","started_at":"2026-09-07T00:00:00Z","completed_at":"2026-09-07T00:00:01Z","commands":[],"tests":[],"log_refs":[]}
            runner = Runner()
            def crash(point, record):
                del record
                if point == "AFTER_WORKSPACE_CREATE":
                    raise RuntimeError("q35-crash")
            service, hermes = second_rework.SecondReworkFocusedTests()._service(
                root, task, {"codex":selected,"claude-code":replace(profile("claude-code"),allowed_endpoints=selected.allowed_endpoints)},
                runner, transition_hook=crash,
            )
            clock = datetime(2026,9,7,tzinfo=timezone.utc)
            hermes.clock = lambda: clock
            with self.assertRaisesRegex(RuntimeError, "q35-crash"):
                service.dispatch(task)
            first = next(item.value for item in service.execution_store._store.list_records())
            self.assertEqual(first.stage, ExecutionStage.WORKSPACE_READY)
            clock += timedelta(hours=2)
            restarted = ProductionExecutionService(
                service.config, hermes, service.execution_store, service.result_sink, runner,
                service.publisher, service.artifact_resolver,
            )
            completed = restarted.resume(task)
            self.assertEqual(completed.stage, ExecutionStage.RESULT_PERSISTED)
            records = [item.value for item in service.execution_store._store.list_records()]
            self.assertEqual(sum(item.stage == ExecutionStage.FAILED for item in records), 1)
            self.assertEqual(sum(item.stage == ExecutionStage.RESULT_PERSISTED for item in records), 1)
            self.assertEqual(runner.calls, 1)
        finally:
            shutil.rmtree(root, ignore_errors=True)


class _ChunkedResponse:
    status = 200

    def __init__(self, url, chunks, content_type="text/event-stream"):
        self._url = url
        self._stream = io.BytesIO(b"".join(chunks))
        self.headers = {"Content-Type": content_type}

    def __enter__(self): return self
    def __exit__(self, *args): return False
    def geturl(self): return self._url
    def read(self, size=-1):
        return self._stream.read(size)


class FourthReworkGatewayTransportTests(unittest.TestCase):
    def test_q42_synthetic_gateway_policy_is_denied_in_production_mode(self):
        key, manifest, _ = gateway_manifest()
        manifest.update(
            upstreamScheme="http", upstreamHost="provider.test.internal", upstreamPort=8080,
            credentialMode="synthetic-emulator",
        )
        manifest["gatewayPolicyFingerprint"] = GatewayPolicy.fingerprint_manifest(manifest)
        policy = GatewayPolicy.from_manifest(key, manifest)
        with self.assertRaisesRegex(GatewayServiceDenied, "production"):
            policy.assert_runtime_mode("PRODUCTION")
        policy.assert_runtime_mode("CODE_QA")

    def test_q37_q38_realistic_streaming_is_forwarded_for_both_providers(self):
        for provider in ("codex", "claude-code"):
            key, manifest, _ = gateway_manifest(provider)
            policy = GatewayPolicy.from_manifest(key, manifest)
            chunks = [b"event: message\n", b"data: {\"type\":\"response.delta\"}\n\n", b"data: [DONE]\n\n"]
            proxy = BoundProviderProxy(
                policy, lambda: "provider-sentinel",
                opener=lambda *args, p=policy, c=chunks, **kwargs: _ChunkedResponse(p.upstream_url, c),
            )
            status, raw, headers = proxy.forward({"model": policy.model, "input": "bounded"})
            self.assertEqual(status, 200)
            self.assertEqual(raw, b"".join(chunks))
            self.assertEqual(headers["Content-Type"], "text/event-stream")

    def test_q39_cumulative_overflow_and_split_credential_reflection_fail_closed(self):
        key, manifest, _ = gateway_manifest()
        manifest["maxResponseBytes"] = 64
        manifest["gatewayPolicyFingerprint"] = GatewayPolicy.fingerprint_manifest(manifest)
        policy = GatewayPolicy.from_manifest(key, manifest)
        overflow = _ChunkedResponse(policy.upstream_url, [b"a" * 40, b"b" * 25])
        with self.assertRaisesRegex(GatewayServiceDenied, "bound"):
            BoundProviderProxy(policy, lambda: "secret", opener=lambda *a, **k: overflow).forward({"model": policy.model})

        reflected = _ChunkedResponse(
            policy.upstream_url,
            [b"data: {\"text\":\"Bearer PRO", b"VIDER-CREDENTIAL\"}\n\n"],
        )
        with self.assertRaisesRegex(GatewayServiceDenied, "rejected") as caught:
            BoundProviderProxy(
                policy, lambda: "PROVIDER-CREDENTIAL", opener=lambda *a, **k: reflected,
            ).forward({"model": policy.model})
        self.assertNotIn("PROVIDER-CREDENTIAL", str(caught.exception))


class FourthReworkCommandAuthorityTests(unittest.TestCase):
    def test_q40_q41_unauthorized_or_malformed_commands_become_policy_denial(self):
        cases = (
            ("codex", CodexExecutionAdapter, "commands", {
                "protocol":"codex-exec-jsonl-v1","status":"completed",
                "started_at":"2026-09-07T00:00:00Z","completed_at":"2026-09-07T00:00:01Z",
                "commands":[],"tests":[],"log_refs":[],
            }),
            ("claude-code", ClaudeCodeExecutionAdapter, "commandsExecuted", {
                "protocol":"claude-code-stream-json-v1","stop_reason":"end_turn",
                "startedAt":"2026-09-07T00:00:00Z","completedAt":"2026-09-07T00:00:01Z",
                "commandsExecuted":[],"testOutcomes":[],"evidenceReferences":[],
            }),
        )
        for provider, adapter_type, field, baseline in cases:
            selected = profile(provider)
            request = request_for(selected)
            for observed in ([request.approved_commands[0], "curl attacker.example"], [123]):
                raw = {**baseline, field:observed}
                result = adapter_type(selected, SyntheticRunner(provider, raw)).execute(request, "/workspace")
                with self.subTest(provider=provider, observed=observed):
                    self.assertEqual(result["disposition"], "EXECUTION_FAILED")
                    self.assertEqual(result["failureClassification"], "POLICY_DENIED")
                    self.assertEqual(result["commandsExecuted"], [])
                    self.assertTrue(result["evidenceReferences"][0].startswith("audit://"))
                    expected_event = (
                        "malformed-command-observation" if observed == [123]
                        else "post-execution-unauthorized-command-observation"
                    )
                    self.assertIn(expected_event, result["evidenceReferences"][0])


class FourthReworkGraphBoundaryTests(unittest.TestCase):
    def test_q42_cross_origin_and_wrong_list_next_links_fail_before_second_token(self):
        for next_link in (
            "https://attacker.example/v1.0/sites/site/lists/list/items?$skiptoken=x",
            "https://graph.microsoft.com/v1.0/sites/site/lists/other/items?$skiptoken=x",
            "https://user@graph.microsoft.com/v1.0/sites/site/lists/list/items?$skiptoken=x",
            "https://graph.microsoft.com:443/v1.0/sites/site/lists/list/items?$skiptoken=x",
        ):
            class Transport:
                calls = 0
                def request(self, method, url, headers, body=None):
                    del method, url, headers, body
                    self.calls += 1
                    return 200, {}, json.dumps({"value": [], "@odata.nextLink": next_link}).encode()
            tokens = []
            transport = Transport()
            store = SharePointListStateStore(
                "https://graph.microsoft.com/v1.0/sites/site/lists/list",
                "prod.exec01.tasks", "prod", lambda: tokens.append("issued") or "token",
                transport=transport,
            )
            with self.subTest(next_link=next_link), self.assertRaisesRegex(RuntimeError, "pagination"):
                store.list_records()
            self.assertEqual(transport.calls, 1)
            self.assertEqual(tokens, ["issued"])


class FourthReworkQualificationTrustTests(unittest.TestCase):
    def test_q31_qualification_loads_actual_persisted_v2_task_record(self):
        collector, _ = authoritative_collector_fixture()
        versioned = collector.task_store.get("task")
        task = versioned.value
        events = []
        for execution in collector.execution_store.list_records():
            provider = execution.value.execution_result["executorProfile"]["provider"]
            fence = 1 if provider == "codex" else 2
            events.append({
                "event":"LEASE_ACQUIRED" if provider == "codex" else "FALLBACK_ATTEMPT_CLAIMED",
                "details":{"attemptId":execution.value.attempt_id,"leaseId":f"lease-{provider}","fencingToken":fence},
            })
        record = TaskRecord(
            key=f"dev.exec01:{task['taskId']}:{task['taskVersion']}", task=copy.deepcopy(task),
            task_fingerprint=fingerprint(task), status=TaskStatus.READY,
            attempt_count=2, fencing_counter=2, audit=events,
        )
        collector.task_store.compare_and_swap("task", versioned.etag, record)
        self.assertEqual(len(collector.resolve()["executionRecords"]), 2)

    def test_q42_minimal_free_form_hermes_pass_row_is_not_authoritative_evidence(self):
        collector, _ = authoritative_collector_fixture()
        versioned = collector.hermes_evidence_store.get("pass")
        minimal = {
            "origin": "trusted-hermes-independent",
            "evidenceIdentity": "hermes://forged/pass",
            "taskFingerprint": collector.task_store.get("task").value["taskId"] and fingerprint(
                collector.task_store.get("task").value
            ),
            "disposition": "PASS",
        }
        collector.hermes_evidence_store.compare_and_swap("pass", versioned.etag, minimal)
        with self.assertRaisesRegex(SystemExit, "Hermes"):
            collector.resolve()

    def test_q42_signed_but_fabricated_source_probe_cannot_qualify(self):
        collector, _ = authoritative_collector_fixture()
        versioned = collector.probe_store.get("probe-codex")
        forged = copy.deepcopy(versioned.value)
        forged["observations"]["providerCredentialReadable"] = True
        unsigned = {key: value for key, value in forged.items() if key != "evidenceFingerprint"}
        forged["evidenceFingerprint"] = fingerprint(unsigned)
        collector.probe_store.compare_and_swap("probe-codex", versioned.etag, forged)
        with self.assertRaisesRegex(SystemExit, "asserted or unbound"):
            collector.resolve()

    def test_q42_code_qa_package_cannot_masquerade_as_live_hostinger(self):
        fixture = Exec01QualificationTests()
        fixture.setUp()
        evidence = fixture._evidence()
        candidate = {key: copy.deepcopy(value) for key, value in evidence.items() if key != "attestation"}
        candidate["qualificationContext"].update(
            mode="LIVE_HOSTINGER", environmentId="hostinger-production",
            profileClass="production-allowlisted", signingPurpose="EXEC01_HOSTINGER_QUALIFICATION",
        )
        signed = sign_evidence(candidate, fixture.key)
        with self.assertRaisesRegex(SystemExit, "SharePoint|synthetic"):
            verify_evidence(
                fixture.profiles, signed, attestation_key=fixture.key,
                trusted_resolver=fixture._resolver(signed),
            )


if __name__ == "__main__":
    unittest.main()
