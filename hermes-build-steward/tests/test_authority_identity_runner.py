from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from hermes_steward.authority import AuthorityDenied, Phase1Authority
from hermes_steward.identity import ManagedIdentityTokenProvider
from hermes_steward.isolation import BoundedProcessRunner, IsolationPolicy


class Phase1AuthorityTests(unittest.TestCase):
    def test_read_only_phase1_authority_is_narrow(self):
        authority = Phase1Authority()
        for capability in (
            "read_specification", "read_acceptance_contract", "inspect_github_evidence",
            "inspect_ci_evidence", "write_task_state", "run_isolated_verification",
        ):
            authority.require(capability)
        for capability in (
            "merge", "deploy", "modify_production_code", "modify_specification",
            "resolve_partner_decision", "access_production_client_documents",
            "dispatch_codex", "dispatch_claude_code",
        ):
            with self.subTest(capability=capability), self.assertRaises(AuthorityDenied):
                authority.require(capability)


class ManagedIdentityTests(unittest.TestCase):
    def test_token_comes_from_vm_metadata_and_is_not_configured_as_a_secret(self):
        observed = {}

        def transport(url, headers):
            observed.update(url=url, headers=headers)
            return json.dumps({"access_token": "short-lived-token", "expires_in": "3599"}).encode()

        provider = ManagedIdentityTokenProvider(transport=transport)
        self.assertEqual(provider(), "short-lived-token")
        self.assertIn("169.254.169.254", observed["url"])
        self.assertEqual(observed["headers"], {"Metadata": "true"})
        self.assertNotIn("short-lived-token", repr(provider))


class BoundedRunnerTests(unittest.TestCase):
    def setUp(self):
        self.policy = IsolationPolicy(
            image="python:3.12-alpine@sha256:" + "a" * 64,
            cpu_limit="1.0", memory_limit="256m", pids_limit=64,
            tmpfs_size="128m", timeout_seconds=1, output_limit_bytes=2048,
        )

    def test_timeout_terminates_runaway_process(self):
        runner = BoundedProcessRunner(self.policy)
        result = runner.run_raw([sys.executable, "-c", "while True: pass"])
        self.assertTrue(result.terminated)
        self.assertEqual(result.termination_reason, "TIME_LIMIT")

    def test_output_limit_terminates_and_bounds_captured_data(self):
        runner = BoundedProcessRunner(self.policy)
        result = runner.run_raw([sys.executable, "-c", "print('x' * 1000000)"])
        self.assertTrue(result.terminated)
        self.assertEqual(result.termination_reason, "OUTPUT_LIMIT")
        self.assertLessEqual(len(result.stdout) + len(result.stderr), self.policy.output_limit_bytes)

    def test_child_process_receives_no_coordinator_secret_environment(self):
        runner = BoundedProcessRunner(self.policy)
        code = "import os; print(os.environ.get('COORDINATOR_SECRET_SENTINEL', 'DENIED'))"
        result = runner.run_raw([sys.executable, "-c", code], host_environment={"COORDINATOR_SECRET_SENTINEL": "EXPOSED"})
        self.assertEqual(result.stdout.strip(), b"DENIED")


if __name__ == "__main__":
    unittest.main()
