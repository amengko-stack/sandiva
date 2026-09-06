from __future__ import annotations

import concurrent.futures
import unittest
from datetime import datetime, timedelta, timezone

from helpers import build_task, normalized_result
from hermes_steward.config import RuntimeConfig
from hermes_steward.coordinator import Coordinator, CoordinatorError, StaleFenceError
from hermes_steward.state import InvalidTransition, TaskStatus, validate_transition
from hermes_steward.store import InMemoryStateStore


class ManualClock:
    def __init__(self):
        self.value = datetime(2026, 9, 5, 8, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += timedelta(seconds=seconds)


def config():
    return RuntimeConfig.from_mapping(
        {
            "environmentKind": "development",
            "runtimeRole": "local-development",
            "environmentId": "hermes-dev-local",
            "taskNamespace": "dev.synthetic",
            "leaseDomain": "dev.local",
            "workerIdentity": "dev-worker-1",
            "hermesVersion": "0.1.0",
            "stateBackend": "memory-test-only",
            "stateEndpoint": "memory://tests",
            "resultMaxBytes": 65536,
        }
    )


class StateMachineTests(unittest.TestCase):
    def test_all_required_states_exist(self):
        expected = {
            "CREATED", "READY", "LEASED", "VERIFYING", "READY_FOR_PM_ACCEPTANCE",
            "REWORK_REQUIRED", "PARTNER_DECISION_REQUIRED", "FAILED", "CANCELLED", "COMPLETE",
        }
        self.assertEqual({value.value for value in TaskStatus}, expected)

    def test_valid_transitions_are_explicit_and_invalid_transitions_fail_closed(self):
        validate_transition(TaskStatus.CREATED, TaskStatus.READY)
        validate_transition(TaskStatus.READY, TaskStatus.LEASED)
        validate_transition(TaskStatus.LEASED, TaskStatus.VERIFYING)
        validate_transition(TaskStatus.VERIFYING, TaskStatus.READY_FOR_PM_ACCEPTANCE)
        with self.assertRaises(InvalidTransition):
            validate_transition(TaskStatus.CREATED, TaskStatus.COMPLETE)
        with self.assertRaises(InvalidTransition):
            validate_transition(TaskStatus.READY_FOR_PM_ACCEPTANCE, TaskStatus.COMPLETE)


class LeaseAndRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.clock = ManualClock()
        self.store = InMemoryStateStore()
        self.coordinator = Coordinator(self.store, config(), clock=self.clock)
        self.task = build_task()
        self.coordinator.submit_task(self.task)

    def test_duplicate_delivery_is_idempotent(self):
        first = self.coordinator.submit_task(self.task)
        second = self.coordinator.submit_task(self.task)
        self.assertEqual(first.task_fingerprint, second.task_fingerprint)
        self.assertEqual(second.attempt_count, 0)

    def test_conflicting_duplicate_delivery_is_rejected(self):
        changed = build_task(scope=["different/**"])
        with self.assertRaisesRegex(CoordinatorError, "conflicting duplicate"):
            self.coordinator.submit_task(changed)

    def test_two_concurrent_claimers_have_exactly_one_owner(self):
        def claim(worker):
            try:
                return self.coordinator.claim(self.task["taskId"], 1, worker, 30)
            except CoordinatorError:
                return None

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            leases = list(pool.map(claim, ["worker-a", "worker-b"]))
        winners = [lease for lease in leases if lease is not None]
        self.assertEqual(len(winners), 1)

    def test_lease_renewal_preserves_fence_and_extends_expiry(self):
        lease = self.coordinator.claim(self.task["taskId"], 1, "worker-a", 30)
        first_expiry = lease.lease_expires_at
        self.clock.advance(10)
        renewed = self.coordinator.renew(self.task["taskId"], 1, lease.lease_id, lease.fencing_token, 60)
        self.assertEqual(renewed.fencing_token, lease.fencing_token)
        self.assertGreater(renewed.lease_expires_at, first_expiry)

    def test_expired_worker_is_fenced_after_takeover(self):
        stale = self.coordinator.claim(self.task["taskId"], 1, "worker-a", 5)
        self.clock.advance(6)
        current = self.coordinator.claim(self.task["taskId"], 1, "worker-b", 30)
        self.assertGreater(current.fencing_token, stale.fencing_token)
        with self.assertRaises(StaleFenceError):
            self.coordinator.begin_verification(self.task["taskId"], 1, stale.lease_id, stale.fencing_token)

    def test_worker_death_takeover_and_restart_recovery_do_not_repeat_completed_work(self):
        stale = self.coordinator.claim(self.task["taskId"], 1, "worker-a", 5)
        self.coordinator.begin_verification(self.task["taskId"], 1, stale.lease_id, stale.fencing_token)
        self.clock.advance(6)
        restarted = Coordinator(self.store, config(), clock=self.clock)
        recovered = restarted.recover(self.task["taskId"], 1)
        self.assertEqual(recovered.status, TaskStatus.REWORK_REQUIRED)
        self.assertEqual(recovered.attempt_count, 1)
        self.assertIsNone(recovered.active_lease)

    def test_validated_pass_is_ready_for_pm_not_complete(self):
        lease = self.coordinator.claim(self.task["taskId"], 1, "worker-a", 30)
        self.coordinator.begin_verification(self.task["taskId"], 1, lease.lease_id, lease.fencing_token)
        record = self.coordinator.complete_attempt(
            self.task["taskId"], 1, normalized_result(self.task, lease), lease.lease_id, lease.fencing_token
        )
        self.assertEqual(record.status, TaskStatus.READY_FOR_PM_ACCEPTANCE)
        self.assertNotEqual(record.status, TaskStatus.COMPLETE)
        self.assertEqual(len(record.results), 1)

    def test_duplicate_result_is_idempotent_but_conflict_is_rejected(self):
        lease = self.coordinator.claim(self.task["taskId"], 1, "worker-a", 30)
        self.coordinator.begin_verification(self.task["taskId"], 1, lease.lease_id, lease.fencing_token)
        result = normalized_result(self.task, lease)
        first = self.coordinator.complete_attempt(self.task["taskId"], 1, result, lease.lease_id, lease.fencing_token)
        etag_before_duplicate = self.store.get(first.key).etag
        second = self.coordinator.complete_attempt(self.task["taskId"], 1, result, lease.lease_id, lease.fencing_token)
        self.assertEqual(len(first.results), len(second.results))
        self.assertEqual(self.store.get(first.key).etag, etag_before_duplicate)
        changed = dict(result, residualRisks=["different"])
        with self.assertRaisesRegex(CoordinatorError, "conflicting result"):
            self.coordinator.complete_attempt(self.task["taskId"], 1, changed, lease.lease_id, lease.fencing_token)

    def test_retry_limit_fails_closed_without_creating_an_extra_attempt(self):
        limited = build_task(taskId="HERMES-01-SYNTHETIC-LIMIT", retryPolicy={"maxAttempts": 1, "backoffSeconds": 0})
        self.coordinator.submit_task(limited)
        lease = self.coordinator.claim(limited["taskId"], 1, "worker-a", 30)
        self.coordinator.begin_verification(limited["taskId"], 1, lease.lease_id, lease.fencing_token)
        self.coordinator.complete_attempt(limited["taskId"], 1, normalized_result(limited, lease, "FAIL"), lease.lease_id, lease.fencing_token)
        with self.assertRaisesRegex(CoordinatorError, "retry limit"):
            self.coordinator.claim(limited["taskId"], 1, "worker-b", 30)
        record = self.store.get(self.coordinator._key(limited["taskId"], 1)).value
        self.assertEqual(record.status, TaskStatus.FAILED)
        self.assertEqual(record.attempt_count, 1)

    def test_fail_creates_rework_and_partner_gate_is_reserved(self):
        lease = self.coordinator.claim(self.task["taskId"], 1, "worker-a", 30)
        self.coordinator.begin_verification(self.task["taskId"], 1, lease.lease_id, lease.fencing_token)
        failed = self.coordinator.complete_attempt(
            self.task["taskId"], 1, normalized_result(self.task, lease, "FAIL"), lease.lease_id, lease.fencing_token
        )
        self.assertEqual(failed.status, TaskStatus.REWORK_REQUIRED)

        other = build_task(taskId="HERMES-01-SYNTHETIC-002")
        self.coordinator.submit_task(other)
        lease2 = self.coordinator.claim(other["taskId"], 1, "worker-a", 30)
        self.coordinator.begin_verification(other["taskId"], 1, lease2.lease_id, lease2.fencing_token)
        hostile_gate = normalized_result(other, lease2, "FAIL")
        hostile_gate["result"] = "PARTNER_DECISION_REQUIRED"
        for criterion in hostile_gate["acceptanceCriteriaResults"]:
            criterion["result"] = "PARTNER_DECISION_REQUIRED"
        with self.assertRaisesRegex(CoordinatorError, "untrusted"):
            self.coordinator.complete_attempt(other["taskId"], 1, hostile_gate, lease2.lease_id, lease2.fencing_token)
        with self.assertRaisesRegex(CoordinatorError, "reserved"):
            self.coordinator.raise_partner_decision(other["taskId"], 1, "test failure", lease2.lease_id, lease2.fencing_token)
        gated = self.coordinator.raise_partner_decision(
            other["taskId"], 1, "material architecture change", lease2.lease_id, lease2.fencing_token
        )
        self.assertEqual(gated.status, TaskStatus.PARTNER_DECISION_REQUIRED)
        self.assertEqual(gated.results[-1]["result"], "PARTNER_DECISION_REQUIRED")
        self.assertEqual(gated.results[-1]["attemptId"], lease2.attempt_id)


if __name__ == "__main__":
    unittest.main()
