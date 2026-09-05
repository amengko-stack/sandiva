from __future__ import annotations

import concurrent.futures
import json
import unittest

from helpers import AC_BYTES, SPEC_BYTES, build_task, normalized_result
from hermes_steward.audit import sanitize_audit_value
from hermes_steward.authority import AuthorityDenied, Phase1Authority
from hermes_steward.config import ConfigurationError, RuntimeConfig
from hermes_steward.contracts import ContractValidationError, validate_build_task, validate_reference_hashes, validate_repository_paths
from hermes_steward.coordinator import Coordinator, CoordinatorError, StaleFenceError
from hermes_steward.evidence import GitHubEvidenceReader
from hermes_steward.state import InvalidTransition, TaskStatus, validate_transition
from hermes_steward.store import InMemoryStateStore
from test_sharepoint_store import FakeGraphTransport
from hermes_steward.sharepoint_store import SharePointListStateStore
from test_state_and_leases import ManualClock, config


def hostinger_production_fields():
    return {
        "vmProvider": "hostinger",
        "graphAuthentication": {
            "provider": "entra-certificate",
            "tenantId": "tenant-id",
            "clientId": "client-id",
            "certificatePath": "/etc/sandiva-hermes/credentials/hermes-graph.pfx",
        },
    }


class OriginalFixturesAToX(unittest.TestCase):
    def new_coordinator(self):
        clock = ManualClock()
        coordinator = Coordinator(InMemoryStateStore(), config(), clock=clock)
        task = build_task()
        coordinator.submit_task(task)
        return coordinator, clock, task

    def verify(self, coordinator, task, result="PASS"):
        lease = coordinator.claim(task["taskId"], task["taskVersion"], "worker-a", 30)
        coordinator.begin_verification(task["taskId"], task["taskVersion"], lease.lease_id, lease.fencing_token)
        record = coordinator.complete_attempt(
            task["taskId"], task["taskVersion"], normalized_result(task, lease, result), lease.lease_id, lease.fencing_token
        )
        return lease, record

    def test_fixture_a_laptop_local_hermes_offline(self):
        production = RuntimeConfig.from_mapping(
            {
                "environmentKind": "production", "runtimeRole": "authoritative-vm",
                "environmentId": "hermes-prod-vm", "taskNamespace": "prod.tasks", "leaseDomain": "prod.vm",
                "workerIdentity": "vm-worker", "hermesVersion": "0.1.0", "stateBackend": "sharepoint-list",
                "stateEndpoint": "https://graph.microsoft.com/v1.0/sites/site/lists/list", "resultMaxBytes": 8192,
                **hostinger_production_fields(),
            }
        )
        self.assertNotIn("local", production.runtime_role)
        self.assertNotIn("c:/users", production.state_endpoint.lower())

    def test_fixture_b_local_cannot_claim_production_task(self):
        with self.assertRaises(ConfigurationError):
            RuntimeConfig.from_mapping(
                {
                    "environmentKind": "development", "runtimeRole": "local-development", "environmentId": "local",
                    "taskNamespace": "prod.tasks", "leaseDomain": "prod.vm", "workerIdentity": "local",
                    "hermesVersion": "0.1.0", "stateBackend": "memory-test-only", "stateEndpoint": "memory://local",
                    "resultMaxBytes": 65536,
                }
            )

    def test_fixture_c_concurrent_lease(self):
        coordinator, _, task = self.new_coordinator()
        def claim(worker):
            try:
                return coordinator.claim(task["taskId"], 1, worker, 30)
            except CoordinatorError:
                return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim, ["a", "b"]))
        self.assertEqual(sum(value is not None for value in results), 1)

    def test_fixture_d_stale_fencing(self):
        coordinator, clock, task = self.new_coordinator()
        stale = coordinator.claim(task["taskId"], 1, "a", 1)
        clock.advance(2)
        coordinator.claim(task["taskId"], 1, "b", 30)
        with self.assertRaises(StaleFenceError):
            coordinator.begin_verification(task["taskId"], 1, stale.lease_id, stale.fencing_token)

    def test_fixture_e_duplicate_task(self):
        coordinator, _, task = self.new_coordinator()
        self.assertEqual(coordinator.submit_task(task).attempt_count, 0)

    def test_fixture_f_forced_restart(self):
        coordinator, clock, task = self.new_coordinator()
        lease = coordinator.claim(task["taskId"], 1, "a", 1)
        coordinator.begin_verification(task["taskId"], 1, lease.lease_id, lease.fencing_token)
        clock.advance(2)
        restarted = Coordinator(coordinator.store, config(), clock=clock)
        self.assertEqual(restarted.recover(task["taskId"], 1).status, TaskStatus.REWORK_REQUIRED)

    def test_fixture_g_expired_lease_recovery(self):
        coordinator, clock, task = self.new_coordinator()
        coordinator.claim(task["taskId"], 1, "a", 1)
        clock.advance(2)
        self.assertEqual(coordinator.recover(task["taskId"], 1).status, TaskStatus.READY)

    def test_fixture_h_malformed_build_task(self):
        with self.assertRaises(ContractValidationError):
            validate_build_task(build_task(schemaVersion="broken"))

    def test_fixture_i_spec_and_acceptance_hash_mismatch(self):
        task = validate_build_task(build_task())
        with self.assertRaises(ContractValidationError):
            validate_reference_hashes(task, b"wrong", AC_BYTES)
        with self.assertRaises(ContractValidationError):
            validate_reference_hashes(task, SPEC_BYTES, b"wrong")

    def test_fixture_j_invalid_transition(self):
        with self.assertRaises(InvalidTransition):
            validate_transition(TaskStatus.CREATED, TaskStatus.COMPLETE)

    def test_fixture_k_no_local_path_dependency(self):
        with self.assertRaises(ConfigurationError):
            RuntimeConfig.from_mapping(
                {
                    "environmentKind": "production", "runtimeRole": "authoritative-vm", "environmentId": "vm",
                    "taskNamespace": "prod.tasks", "leaseDomain": "prod.vm", "workerIdentity": "vm",
                    "hermesVersion": "0.1.0", "stateBackend": "sharepoint-list",
                    "stateEndpoint": "C:\\Users\\partner\\OneDrive\\state", "resultMaxBytes": 65536,
                    **hostinger_production_fields(),
                }
            )

    def test_fixture_l_health_fields(self):
        coordinator, _, _ = self.new_coordinator()
        expected = {"hermesVersion", "configurationFingerprint", "environmentIdentity", "workerIdentity", "lastHeartbeat", "currentTask", "currentLease", "pendingTaskVisibility", "lastSuccessfulTask", "lastFailedTask", "dependencyHealth"}
        self.assertEqual(set(coordinator.health()), expected)

    def test_fixture_m_secret_sentinel(self):
        sentinel = "COORDINATOR-SECRET-SENTINEL"
        self.assertNotIn(sentinel, json.dumps(sanitize_audit_value({"accessToken": sentinel})))

    def test_fixture_n_no_production_client_access(self):
        with self.assertRaises(AuthorityDenied):
            Phase1Authority().require("access_production_client_documents")

    def test_fixture_o_pass_does_not_merge(self):
        coordinator, _, task = self.new_coordinator()
        _, record = self.verify(coordinator, task)
        self.assertEqual(record.status, TaskStatus.READY_FOR_PM_ACCEPTANCE)
        with self.assertRaises(AuthorityDenied):
            Phase1Authority().require("merge")

    def test_fixture_p_fail_creates_rework_disposition(self):
        coordinator, _, task = self.new_coordinator()
        _, record = self.verify(coordinator, task, "FAIL")
        self.assertEqual(record.status, TaskStatus.REWORK_REQUIRED)

    def test_fixture_q_genuine_partner_gate(self):
        coordinator, _, task = self.new_coordinator()
        lease = coordinator.claim(task["taskId"], 1, "a", 30)
        coordinator.begin_verification(task["taskId"], 1, lease.lease_id, lease.fencing_token)
        record = coordinator.raise_partner_decision(task["taskId"], 1, "material architecture change", lease.lease_id, lease.fencing_token)
        self.assertEqual(record.status, TaskStatus.PARTNER_DECISION_REQUIRED)

    def test_fixture_r_routine_failure_does_not_escalate(self):
        coordinator, _, task = self.new_coordinator()
        lease = coordinator.claim(task["taskId"], 1, "a", 30)
        coordinator.begin_verification(task["taskId"], 1, lease.lease_id, lease.fencing_token)
        with self.assertRaises(CoordinatorError):
            coordinator.raise_partner_decision(task["taskId"], 1, "test failure", lease.lease_id, lease.fencing_token)

    def test_fixture_s_github_ci_traceability(self):
        sha = "c59596559515efa6e088eff4024f90cdca5b3898"
        coordinator, _, _ = self.new_coordinator()
        task = build_task(
            taskId="HERMES-01-SYNTHETIC-CI",
            acceptanceCriteria=["AC-CI"],
            criterionEvidencePolicy={
                "AC-CI": {
                    "allowedEvidence": [
                        {"origin": "TRUSTED_EXTERNAL_SYSTEM", "kind": "github-ci"}
                    ]
                }
            },
            commitRefs=[sha],
        )
        coordinator.submit_task(task)
        lease = coordinator.claim(task["taskId"], 1, "a", 30)
        coordinator.begin_verification(task["taskId"], 1, lease.lease_id, lease.fencing_token)

        class Transport:
            def __init__(self):
                self.calls = []

            def request(self, method, url, headers, body=None):
                self.calls.append((method, url))
                if url.endswith("/check-runs"):
                    payload = {"check_runs": [{"id": 1, "name": "Hermes", "conclusion": "success", "head_sha": sha}]}
                else:
                    payload = {"sha": sha, "html_url": f"https://github.com/amengko-stack/sandiva/commit/{sha}"}
                return 200, {}, json.dumps(payload).encode()

        transport = Transport()
        evidence = coordinator.retrieve_github_ci_evidence(
            task["taskId"], 1, lease.lease_id, lease.fencing_token, sha, ["AC-CI"],
            GitHubEvidenceReader(transport=transport),
        )
        candidate = normalized_result(task, lease)
        candidate["deterministicEvidence"] = []
        candidate["acceptanceCriteriaResults"] = [
            {"criterion": "AC-CI", "result": "PASS", "evidenceRefs": [evidence.evidence_ref]}
        ]
        record = coordinator.complete_attempt(
            task["taskId"], 1, candidate, lease.lease_id, lease.fencing_token,
            trusted_evidence=[evidence],
        )
        result = record.results[0]
        self.assertEqual(result["repository"], task["repository"])
        self.assertEqual(result["deterministicEvidence"][0]["evidenceRef"], evidence.evidence_ref)
        self.assertEqual(result["deterministicEvidence"][0]["trustedOrigin"], "TRUSTED_EXTERNAL_SYSTEM")
        self.assertEqual([method for method, _ in transport.calls], ["GET", "GET"])

    def test_fixture_t_audit_reconstruction(self):
        coordinator, _, task = self.new_coordinator()
        lease, record = self.verify(coordinator, task)
        encoded = json.dumps(record.audit)
        for value in (task["taskId"], lease.lease_id, lease.attempt_id, task["specificationHash"]):
            if value == task["specificationHash"]:
                self.assertEqual(record.task["specificationHash"], value)
            else:
                self.assertIn(value, encoded)

    def test_fixture_u_non_production_local_fallback(self):
        self.assertEqual(config().runtime_role, "local-development")
        self.assertTrue(config().task_namespace.startswith("dev."))

    def test_fixture_v_no_executor_dispatch(self):
        task = validate_build_task(build_task())
        self.assertFalse(task["executorPolicy"]["automaticDispatch"])
        for capability in ("dispatch_codex", "dispatch_claude_code"):
            with self.assertRaises(AuthorityDenied):
                Phase1Authority().require(capability)

    def test_fixture_w_current_sandiva_main_unaffected(self):
        task = validate_build_task(build_task())
        self.assertEqual(task["baseRef"], "c59596559515efa6e088eff4024f90cdca5b3898")
        with self.assertRaises(ContractValidationError):
            validate_repository_paths(task, ["sln-litigation-drafter/app/api/dd/analyze/route.ts"])

    def test_fixture_x_filesystem_deletion_does_not_destroy_canonical_history(self):
        transport = FakeGraphTransport()
        endpoint = "https://graph.microsoft.com/v1.0/sites/site/lists/list"
        first = SharePointListStateStore(endpoint, "dev.synthetic", "dev", lambda: "graph-token", transport=transport)
        coordinator = Coordinator(first, config())
        record = coordinator.submit_task(build_task())
        del coordinator, first
        restarted = SharePointListStateStore(endpoint, "dev.synthetic", "dev", lambda: "graph-token", transport=transport)
        self.assertEqual(restarted.get(record.key).value.task_fingerprint, record.task_fingerprint)


if __name__ == "__main__":
    unittest.main()
