from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from dataclasses import replace
from pathlib import Path

from hermes_steward.execution_contracts import ExecutionContractError, ExecutorProfile
from hermes_steward.execution_isolation import (
    BoundedExecutionRunner,
    BoundedExecutionResult,
    ContainerProviderRunner,
    ContainmentPolicy,
    NetworkPolicyDenied,
    WorkspaceError,
    WorkspaceFactory,
    build_executor_container_command,
    sanitized_executor_environment,
)
from test_execution_adapters import profile, request_for


def containment(**overrides):
    values = {
        "cpu_limit": "2.0", "memory_limit": "4g", "pids_limit": 256,
        "workspace_limit_bytes": 2_000_000_000, "wall_time_seconds": 2,
        "output_limit_bytes": 4096, "network_name": "exec-01-egress",
        "allowed_endpoints": ("executor-gateway.sandiva.internal:8443", "registry.npmjs.org:443"),
    }
    values.update(overrides)
    return ContainmentPolicy(**values)


class CredentialAndNetworkIsolationTests(unittest.TestCase):
    def test_profiles_require_a_fingerprinted_trusted_gateway_not_raw_credentials(self):
        base = profile("codex").as_dict()
        base["credential_mode"] = "environment-token"
        with self.assertRaisesRegex(ExecutionContractError, "trusted-egress-gateway"):
            ExecutorProfile(**base)
        base = profile("claude-code").as_dict()
        base["gateway_endpoint"] = "api.anthropic.com:443"
        with self.assertRaisesRegex(ExecutionContractError, "gateway endpoint"):
            ExecutorProfile(**base)

    def test_real_repository_child_process_cannot_recover_any_parent_secret(self):
        request = request_for(profile("codex"))
        policy = containment()
        parent = {
            "OPENAI_API_KEY": "OPENAI-SENTINEL",
            "CODEX_API_KEY": "CODEX-SENTINEL",
            "ANTHROPIC_API_KEY": "ANTHROPIC-SENTINEL",
            "GITHUB_TOKEN": "PUBLISHER-SENTINEL",
            "HERMES_PFX": "PFX-SENTINEL",
            "HERMES_GRAPH_TOKEN": "GRAPH-SENTINEL",
            "HERMES_STATE_CREDENTIAL": "STATE-SENTINEL",
            "CONTROL_TOWER_CREDENTIAL": "CONTROL-TOWER-SENTINEL",
            "COORDINATOR_SECRET": "COORDINATOR-SENTINEL",
        }
        child = sanitized_executor_environment(parent, request, policy)
        probe = (
            "import os,json; keys=" + repr(sorted(parent)) + "; "
            "print(json.dumps({k:('EXPOSED' if os.getenv(k) else 'DENIED') for k in keys},sort_keys=True))"
        )
        result = BoundedExecutionRunner(policy).run_raw([sys.executable, "-c", probe], child)
        self.assertEqual(result.return_code, 0)
        self.assertTrue(all(value == "DENIED" for value in __import__("json").loads(result.stdout).values()))
        self.assertNotIn(b"SENTINEL", result.stdout + result.stderr)

    def test_network_policy_denies_graph_sharepoint_metadata_private_and_browser_targets(self):
        policy = containment()
        self.assertEqual(policy.authorize_endpoint("executor-gateway.sandiva.internal:8443"), "executor-gateway.sandiva.internal:8443")
        for target in (
            "graph.microsoft.com:443", "sandiva.sharepoint.com:443", "169.254.169.254:80",
            "10.0.0.8:443", "127.0.0.1:9222", "browser.sandiva.internal:443",
            "attacker.example:443",
        ):
            with self.subTest(target=target):
                with self.assertRaises(NetworkPolicyDenied):
                    policy.authorize_endpoint(target)

    def test_container_command_has_only_sealed_request_and_workspace_mounts_and_all_bounds(self):
        executor_profile = profile("codex")
        request = request_for(executor_profile)
        policy = containment()
        command = build_executor_container_command(
            executor_profile, policy, request, "/srv/sandiva/workspaces/attempt-1", "/run/sandiva/requests/attempt-1.json"
        )
        rendered = " ".join(command)
        for fragment in (
            "--cpus 2.0", "--memory 4g", "--pids-limit 256", "--read-only",
            "--cap-drop ALL", "no-new-privileges", "--network exec-01-egress",
            "dst=/workspace", "dst=/run/exec/request.json,readonly", "size=2000000000",
        ):
            self.assertIn(fragment, rendered)
        for forbidden in ("docker.sock", "OneDrive", "C:/Users", "github", "pfx", "token", "secret"):
            self.assertNotIn(forbidden.lower(), rendered.lower())
        self.assertEqual(command[-len(executor_profile.fixed_argv):], list(executor_profile.fixed_argv))


class ResourceBoundaryTests(unittest.TestCase):
    def test_output_flood_is_bounded_and_terminated(self):
        policy = containment(output_limit_bytes=256)
        result = BoundedExecutionRunner(policy).run_raw(
            [sys.executable, "-c", "import sys; sys.stdout.write('x'*1000000); sys.stdout.flush()"], {}
        )
        self.assertEqual(result.termination_reason, "OUTPUT_LIMIT")
        self.assertLessEqual(len(result.stdout) + len(result.stderr), 256)
        self.assertTrue(result.process_tree_terminated)

    def test_timeout_terminates_process_tree(self):
        policy = containment(wall_time_seconds=1)
        result = BoundedExecutionRunner(policy).run_raw(
            [sys.executable, "-c", "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); time.sleep(60)"],
            {},
        )
        self.assertEqual(result.termination_reason, "TIME_LIMIT")
        self.assertTrue(result.process_tree_terminated)


class WorkspaceTests(unittest.TestCase):
    def test_workspace_starts_at_exact_base_and_identity_cannot_be_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "source")
            root = Path(directory, "workspaces")
            source.mkdir()
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            subprocess.run(["git", "-C", str(source), "config", "user.email", "test@sandiva.invalid"], check=True)
            subprocess.run(["git", "-C", str(source), "config", "user.name", "Sandiva Test"], check=True)
            Path(source, "README.md").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(source), "add", "README.md"], check=True)
            subprocess.run(["git", "-C", str(source), "commit", "-q", "-m", "base"], check=True)
            base_sha = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
            executor_profile = profile("codex")
            request = replace(request_for(executor_profile), base_sha=base_sha)
            factory = WorkspaceFactory(root)
            workspace = factory.create(request, source)
            observed = subprocess.check_output(["git", "-C", str(workspace.path), "rev-parse", "HEAD"], text=True).strip()
            self.assertEqual(observed, base_sha)
            self.assertTrue(str(workspace.path.resolve()).startswith(str(root.resolve())))
            with self.assertRaisesRegex(WorkspaceError, "already exists"):
                factory.create(request, source)


class ContainerProviderRunnerTests(unittest.TestCase):
    def test_provider_runner_uses_sealed_request_fixed_profile_and_removes_request_file(self):
        class FakeRunner:
            command = None
            environment = None

            def run_raw(self, command, environment):
                self.command = command
                self.environment = environment
                raw = {
                    "status": "completed", "started_at": "2026-09-06T10:00:00Z",
                    "completed_at": "2026-09-06T10:00:01Z", "commands": [], "tests": [],
                    "changed_paths": [], "patch_digest": "1" * 64, "log_refs": [],
                }
                return BoundedExecutionResult(0, __import__("json").dumps(raw).encode(), b"", None, 0.1, True)

        with tempfile.TemporaryDirectory() as directory:
            fake = FakeRunner()
            executor_profile = profile("codex")
            request = request_for(executor_profile)
            captured = {}

            def command_builder(observed_profile, observed_policy, observed_request, workspace, sealed):
                captured["profile"] = observed_profile
                captured["workspace"] = workspace
                captured["request"] = __import__("json").loads(Path(sealed).read_text(encoding="utf-8"))
                return ["container", "--gateway", observed_profile.gateway_endpoint]

            with patch("hermes_steward.execution_isolation.build_executor_container_command", side_effect=command_builder):
                result = ContainerProviderRunner(containment(), Path(directory), runner=fake).invoke(
                    executor_profile, request, "/srv/sandiva/workspaces/attempt-1"
                )
            self.assertEqual(result["status"], "completed")
            rendered = " ".join(fake.command)
            self.assertIn("executor-gateway.sandiva.internal:8443", rendered)
            self.assertEqual(captured["profile"], executor_profile)
            self.assertEqual(captured["request"], request.as_dict())
            self.assertNotIn("TOKEN", __import__("json").dumps(fake.environment).upper())
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
