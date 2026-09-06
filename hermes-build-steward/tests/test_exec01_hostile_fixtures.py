from __future__ import annotations

import copy
import os
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from helpers import build_task
from hermes_steward.contracts import ContractValidationError, validate_build_task, validate_dispatch_build_task
from hermes_steward.execution_contracts import (
    ExecutionContractError, ExecutorProfileRegistry, validate_execution_result,
)
from hermes_steward.execution_coordinator import RecoveryError, select_executor_profile
from hermes_steward.execution_isolation import (
    BoundedExecutionRunner, NetworkPolicyDenied, sanitized_executor_environment,
)
from hermes_steward.execution_publisher import (
    PublicationConflict, PublisherAuthority, PublisherAuthorityDenied,
    StalePublicationAuthority, TrustedGitHubPublisher, deterministic_branch,
    deterministic_pr_identity,
)
from hermes_steward.prepublication import PrepublicationError, PrepublicationInspector
from test_execution_adapters import profile, request_for
from test_execution_isolation import containment
from test_execution_publisher import InMemoryGitHubGateway, changes
import test_execution_recovery as recovery_helpers
from test_execution_task_contract import dispatch_task
from test_prepublication import repository


class Exec01HostileFixtures(unittest.TestCase):
    def test_01_malformed_dispatch_capable_task(self):
        task = dispatch_task()
        del task["dispatchPolicy"]
        with self.assertRaises(ContractValidationError):
            validate_dispatch_build_task(task)

    def test_02_v1_task_requesting_dispatch(self):
        task = build_task()
        task["executorPolicy"]["automaticDispatch"] = True
        with self.assertRaisesRegex(ContractValidationError, "automaticDispatch"):
            validate_build_task(task)

    def test_03_mixed_or_downgrade_task_version(self):
        task = dispatch_task()
        task["schemaVersion"] = "1.0"
        with self.assertRaisesRegex(ContractValidationError, "schemaVersion 2.0"):
            validate_dispatch_build_task(task)

    def test_04_unauthorized_executor_profile(self):
        registry = ExecutorProfileRegistry([profile("codex")])
        with self.assertRaisesRegex(ExecutionContractError, "not allowlisted"):
            registry.resolve("hostile-profile", "0" * 64)

    def test_05_arbitrary_executable_path_injection(self):
        task = dispatch_task(executablePath="C:/Windows/System32/cmd.exe")
        with self.assertRaisesRegex(ContractValidationError, "unknown fields"):
            validate_dispatch_build_task(task)

    def test_06_repository_request_to_widen_authority(self):
        request = request_for(profile("codex"))
        hostile = recovery_helpers.successful_result(request)
        hostile["changedPaths"] = [".github/workflows/deploy.yml"]
        with self.assertRaisesRegex(ExecutionContractError, "path authority"):
            validate_execution_result(hostile, request)

    def test_07_prohibited_path_write(self):
        request = request_for(profile("codex"))
        with self.assertRaisesRegex(PrepublicationError, "permission envelope"):
            PrepublicationInspector().validate_paths(request, [".github/workflows/hostile.yml"])

    def test_08_traversal_escape(self):
        request = request_for(profile("codex"))
        with self.assertRaisesRegex(PrepublicationError, "escapes root"):
            PrepublicationInspector().validate_paths(request, ["../outside.txt"])

    def test_09_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root, request = repository(directory)
            blob = subprocess.check_output(
                ["git", "-C", str(root), "hash-object", "-w", "--stdin"],
                input="../../outside", text=True,
            ).strip()
            subprocess.run(
                ["git", "-C", str(root), "update-index", "--add", "--cacheinfo", f"120000,{blob},allowed/link"],
                check=True,
            )
            with self.assertRaisesRegex(PrepublicationError, "symlink escape"):
                PrepublicationInspector().inspect(root, request)

    def test_10_submodule_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root, request = repository(directory)
            subprocess.run(
                ["git", "-C", str(root), "update-index", "--add", "--cacheinfo", f"160000,{request.base_sha},allowed/submodule"],
                check=True,
            )
            with self.assertRaisesRegex(PrepublicationError, "submodule"):
                PrepublicationInspector().inspect(root, request)

    @staticmethod
    def _probe_environment(secret_keys):
        request = request_for(profile("codex"))
        policy = containment()
        host = {key: f"{key}-SENTINEL" for key in secret_keys}
        child = sanitized_executor_environment(host, request, policy)
        probe = "import os;print('|'.join('EXPOSED' if os.getenv(k) else 'DENIED' for k in " + repr(secret_keys) + "))"
        return BoundedExecutionRunner(policy).run_raw([sys.executable, "-c", probe], child)

    def test_11_provider_credential_probe(self):
        result = self._probe_environment(["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"])
        self.assertEqual(result.stdout.decode().strip(), "DENIED|DENIED|DENIED")

    def test_12_github_publisher_credential_probe(self):
        self.assertEqual(self._probe_environment(["GITHUB_TOKEN"]).stdout.decode().strip(), "DENIED")

    def test_13_hermes_pfx_probe(self):
        self.assertEqual(self._probe_environment(["HERMES_PFX", "HERMES_PFX_PASSWORD"]).stdout.decode().strip(), "DENIED|DENIED")

    def test_14_hermes_graph_token_probe(self):
        self.assertEqual(self._probe_environment(["HERMES_GRAPH_TOKEN"]).stdout.decode().strip(), "DENIED")

    def test_15_durable_state_credential_probe(self):
        result = self._probe_environment(["HERMES_STATE_CREDENTIAL", "COORDINATOR_SECRET"])
        self.assertEqual(result.stdout.decode().strip(), "DENIED|DENIED")

    def test_16_docker_socket_probe(self):
        child = sanitized_executor_environment({}, request_for(profile("codex")), containment())
        self.assertFalse(any("docker" in key.lower() or "socket" in value.lower() for key, value in child.items()))

    def test_17_metadata_or_private_network_probe(self):
        for endpoint in ("169.254.169.254:80", "10.0.0.1:443", "graph.microsoft.com:443"):
            with self.subTest(endpoint=endpoint), self.assertRaises(NetworkPolicyDenied):
                containment().authorize_endpoint(endpoint)

    def test_18_runaway_child_process(self):
        result = BoundedExecutionRunner(containment(wall_time_seconds=1)).run_raw(
            [sys.executable, "-c", "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);time.sleep(60)"], {}
        )
        self.assertEqual((result.termination_reason, result.process_tree_terminated), ("TIME_LIMIT", True))

    def test_19_output_flood(self):
        result = BoundedExecutionRunner(containment(output_limit_bytes=128)).run_raw(
            [sys.executable, "-c", "print('x'*1000000)"], {}
        )
        self.assertEqual(result.termination_reason, "OUTPUT_LIMIT")
        self.assertLessEqual(len(result.stdout) + len(result.stderr), 128)

    @staticmethod
    def _recovery_fixture(crash_point=None):
        case = recovery_helpers.RecoveryTests()
        case.setUp()
        if crash_point:
            case.gateway.crash_point = crash_point
            with case.assertRaises(RuntimeError):
                case.coordinator().dispatch(case.request)
            case.gateway.crash_point = None
        return case

    def test_20_duplicate_delivery(self):
        case = self._recovery_fixture()
        first = case.coordinator().dispatch(case.request)
        second = case.coordinator().dispatch(case.request)
        self.assertEqual(first, second)
        self.assertEqual(case.adapter.calls, 1)

    def test_21_stale_fencing_token(self):
        request = request_for(profile("codex"))
        gateway = InMemoryGitHubGateway()
        with self.assertRaisesRegex(StalePublicationAuthority, "stale"):
            TrustedGitHubPublisher(gateway).publish_draft(
                request, changes(), "/workspace",
                lambda: (_ for _ in ()).throw(StalePublicationAuthority("stale fence")),
            )
        self.assertEqual(gateway.push_calls, 0)

    def test_22_crash_after_local_commit(self):
        case = self._recovery_fixture("AFTER_COMMIT")
        case.coordinator().resume(case.request)
        self.assertEqual((case.gateway.commit_calls, case.gateway.push_calls), (1, 1))

    def test_23_crash_after_push(self):
        case = self._recovery_fixture("AFTER_PUSH")
        case.coordinator().resume(case.request)
        self.assertEqual((case.gateway.push_calls, case.gateway.pr_calls), (1, 1))

    def test_24_crash_after_pr_creation(self):
        case = self._recovery_fixture("AFTER_PR")
        case.coordinator().resume(case.request)
        self.assertEqual(case.gateway.pr_calls, 1)

    def test_25_conflicting_existing_branch(self):
        request = request_for(profile("codex"))
        gateway = InMemoryGitHubGateway()
        gateway.branches[deterministic_branch(request)] = {"taskFingerprint": "0" * 64}
        with self.assertRaisesRegex(PublicationConflict, "branch"):
            TrustedGitHubPublisher(gateway).publish_draft(request, changes(), "/workspace", lambda: None)

    def test_26_conflicting_existing_pr(self):
        request = request_for(profile("codex"))
        gateway = InMemoryGitHubGateway()
        gateway.prs[deterministic_pr_identity(request)] = {"taskFingerprint": "0" * 64}
        with self.assertRaisesRegex(PublicationConflict, "pull request"):
            TrustedGitHubPublisher(gateway).publish_draft(request, changes(), "/workspace", lambda: None)

    def test_27_forged_executor_result(self):
        request = request_for(profile("codex"))
        forged = recovery_helpers.successful_result(request)
        forged["baseSha"] = "0" * 40
        with self.assertRaisesRegex(ExecutionContractError, "baseSha"):
            validate_execution_result(forged, request)

    def test_28_executor_claiming_acceptance_or_pass(self):
        request = request_for(profile("codex"))
        forged = recovery_helpers.successful_result(request)
        forged["acceptanceDisposition"] = "READY_FOR_PM_ACCEPTANCE"
        with self.assertRaisesRegex(ExecutionContractError, "cannot assert acceptance"):
            validate_execution_result(forged, request)

    def test_29_silent_fallback_attempt(self):
        codex, claude = profile("codex"), profile("claude-code")
        task = {"dispatchPolicy": {
            "executorProfile": {"profileId": codex.profile_id, "profileFingerprint": codex.fingerprint},
            "permittedFallbackProfiles": [{"profileId": claude.profile_id, "profileFingerprint": claude.fingerprint}],
            "fallbackMode": "NONE", "noDowngrade": True,
        }}
        with self.assertRaisesRegex(RecoveryError, "no authorized executor"):
            select_executor_profile(task, ExecutorProfileRegistry([codex, claude]), {codex.profile_id})

    def test_30_automatic_merge_attempt(self):
        with self.assertRaises(PublisherAuthorityDenied):
            PublisherAuthority().require("merge")

    def test_31_production_deployment_attempt(self):
        with self.assertRaises(PublisherAuthorityDenied):
            PublisherAuthority().require("deploy")


if __name__ == "__main__":
    unittest.main()
