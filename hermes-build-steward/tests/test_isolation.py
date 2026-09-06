from __future__ import annotations

import json
import unittest
from pathlib import Path

from helpers import build_task, normalized_result
from hermes_steward.contracts import ContractValidationError, validate_build_task
from hermes_steward.isolation import BoundedProcessRunner, IsolationPolicy, build_docker_command, sanitized_job_environment
from hermes_steward.results import REQUIRED_RESULT_FIELDS, ResultValidationError, validate_job_result


class IsolationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = IsolationPolicy(
            image="python:3.12-alpine@sha256:" + "a" * 64,
            cpu_limit="1.0", memory_limit="512m", pids_limit=128,
            tmpfs_size="256m", timeout_seconds=300, output_limit_bytes=65536,
            network_mode="none",
        )

    def test_a1_secret_isolation_job_environment_is_allowlist_only(self):
        host = {"PATH": "/usr/bin", "HERMES_GRAPH_TOKEN": "COORDINATOR-SECRET-SENTINEL", "HOME": "/root"}
        job = sanitized_job_environment(host, {"HERMES_TASK_ID": "synthetic"})
        self.assertEqual(job, {"HERMES_TASK_ID": "synthetic"})
        self.assertNotIn("COORDINATOR-SECRET-SENTINEL", json.dumps(job))

    def test_a2_task_state_authority_is_not_mounted_or_passed(self):
        command = build_docker_command(self.policy, "/tmp/job-1", ["python", "verify.py"])
        encoded = " ".join(command)
        self.assertNotIn("graph", encoded.lower())
        self.assertNotIn("task-state", encoded.lower())
        self.assertNotIn("docker.sock", encoded.lower())

    def test_a3_filesystem_isolation_has_single_workspace_mount_and_hardened_root(self):
        command = build_docker_command(self.policy, "/tmp/job-1", ["python", "verify.py"])
        self.assertIn("--read-only", command)
        mounts = [command[index + 1] for index, item in enumerate(command[:-1]) if item == "--mount"]
        self.assertEqual(mounts, ["type=bind,src=/tmp/job-1,dst=/input,readonly"])
        tmpfs_values = [command[index + 1] for index, item in enumerate(command[:-1]) if item == "--tmpfs"]
        self.assertTrue(any(value.startswith("/workspace:") for value in tmpfs_values))
        self.assertIn("no-new-privileges", command)
        self.assertIn("ALL", command)

    def test_a4_network_is_deny_by_default(self):
        command = build_docker_command(self.policy, "/tmp/job-1", ["python", "verify.py"])
        index = command.index("--network")
        self.assertEqual(command[index + 1], "none")

    def test_a5_resource_bounds_are_mandatory(self):
        command = build_docker_command(self.policy, "/tmp/job-1", ["python", "verify.py"])
        for flag in ("--cpus", "--memory", "--pids-limit", "--tmpfs"):
            self.assertIn(flag, command)
        self.assertGreater(self.policy.timeout_seconds, 0)
        self.assertGreater(self.policy.output_limit_bytes, 0)

    def test_container_id_is_captured_for_forced_cleanup(self):
        command = build_docker_command(
            self.policy, "/tmp/job-1", ["python", "verify.py"], cidfile="/tmp/coordinator/job.cid"
        )
        index = command.index("--cidfile")
        self.assertEqual(command[index + 1], "/tmp/coordinator/job.cid")

    def test_runner_rejects_a_command_not_authorized_by_the_task_before_launch(self):
        task = validate_build_task(build_task())
        runner = BoundedProcessRunner(self.policy)
        with self.assertRaises(ContractValidationError):
            runner.run_verification(task, "/tmp/job-1", ["python", "hostile.py"])


class ResultBoundaryTests(unittest.TestCase):
    def setUp(self):
        from types import SimpleNamespace

        self.task = build_task()
        self.lease = SimpleNamespace(attempt_id="attempt-1", worker_id="worker-1", lease_id="lease-1", fencing_token=3)
        self.result = normalized_result(self.task, self.lease)

    def test_a6_malformed_oversized_and_forged_results_are_rejected(self):
        with self.assertRaises(ResultValidationError):
            validate_job_result(b"not-json", self.task, self.lease, 65536)
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(self.result).encode(), self.task, self.lease, 16)
        forged = dict(self.result, fencingToken=2)
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(forged).encode(), self.task, self.lease, 65536)

    def test_result_rejects_secret_bearing_fields_and_malformed_nested_types(self):
        secret = json.loads(json.dumps(self.result))
        secret["deterministicEvidence"][0]["accessToken"] = "COORDINATOR-SECRET-SENTINEL"
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(secret).encode(), self.task, self.lease, 65536)
        malformed = json.loads(json.dumps(self.result))
        malformed["acceptanceCriteriaResults"][0]["evidenceRefs"] = [7]
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(malformed).encode(), self.task, self.lease, 65536)

    def test_a7_normal_result_is_accepted(self):
        validated = validate_job_result(json.dumps(self.result).encode(), self.task, self.lease, 65536)
        self.assertEqual(validated["result"], "PASS")

    def test_pass_requires_exactly_one_pass_for_every_task_criterion(self):
        missing = dict(self.result, acceptanceCriteriaResults=self.result["acceptanceCriteriaResults"][:1])
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(missing).encode(), self.task, self.lease, 65536)
        duplicate = dict(self.result, acceptanceCriteriaResults=self.result["acceptanceCriteriaResults"] * 2)
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(duplicate).encode(), self.task, self.lease, 65536)
        failed = json.loads(json.dumps(self.result))
        failed["acceptanceCriteriaResults"][0]["result"] = "FAIL"
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(failed).encode(), self.task, self.lease, 65536)

    def test_overall_disposition_must_match_criterion_dispositions(self):
        inconsistent_fail = dict(self.result, result="FAIL")
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(inconsistent_fail).encode(), self.task, self.lease, 65536)
        inconsistent_gate = json.loads(json.dumps(self.result))
        inconsistent_gate["acceptanceCriteriaResults"][0]["result"] = "PARTNER_DECISION_REQUIRED"
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(inconsistent_gate).encode(), self.task, self.lease, 65536)

    def test_published_result_schema_matches_runtime_required_fields(self):
        schema = json.loads((Path(__file__).parents[1] / "schemas" / "normalized-build-result-v1.schema.json").read_text(encoding="utf-8"))
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), REQUIRED_RESULT_FIELDS)


if __name__ == "__main__":
    unittest.main()
