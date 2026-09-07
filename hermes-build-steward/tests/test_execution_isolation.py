from __future__ import annotations

import os
import base64
import io
import json
import subprocess
import sys
import tarfile
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
    DockerContainerJobRunner,
    DockerNetworkAttestor,
    GatewayNetworkBinding,
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
        "output_limit_bytes": 4096, "network_name": "exec-01-internal",
        "allowed_endpoints": ("executor-gateway.sandiva.internal:8443", "registry.npmjs.org:443"),
    }
    values.update(overrides)
    return ContainmentPolicy(**values)


class CredentialAndNetworkIsolationTests(unittest.TestCase):
    def test_network_attestation_requires_internal_network_exact_gateway_and_no_extra_peer(self):
        """Catches a named bridge or unexpected peer being mistaken for enforced egress."""
        executor_profile = profile("codex")
        policy = containment()
        binding = GatewayNetworkBinding(
            network_name=policy.network_name,
            container_name="exec01-gateway",
            image="registry.example/sandiva/gateway@sha256:" + "a" * 64,
            policy_fingerprint=policy.network_policy_fingerprint,
        )
        network = {
            "Name": policy.network_name,
            "Internal": True,
            "Containers": {"gateway-id": {"Name": binding.container_name}},
        }
        gateway = {
            "Name": "/exec01-gateway",
            "Config": {
                "Image": binding.image,
                "Labels": {"sandiva.exec.gateway-policy": binding.policy_fingerprint},
            },
            "NetworkSettings": {"Networks": {policy.network_name: {}}},
        }

        DockerNetworkAttestor(binding, inspect=lambda kind, name: network if kind == "network" else gateway).attest(
            executor_profile, policy
        )

        for label, mutation in (
            ("external bridge", {**network, "Internal": False}),
            ("unexpected peer", {**network, "Containers": {**network["Containers"], "evil": {"Name": "evil"}}}),
        ):
            with self.subTest(label=label), self.assertRaises(NetworkPolicyDenied):
                DockerNetworkAttestor(
                    binding, inspect=lambda kind, name, value=mutation: value if kind == "network" else gateway
                ).attest(executor_profile, policy)

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

    def test_container_command_uses_streamed_seed_and_quota_tmpfs_without_any_host_mount(self):
        """Catches reintroduction of unreadable seed/request binds or an unbounded writable mount."""
        executor_profile = profile("codex")
        request = request_for(executor_profile)
        policy = containment()
        command = build_executor_container_command(
            executor_profile, policy, request, "/srv/sandiva/workspaces/attempt-1", "exec01-attempt-1"
        )
        rendered = " ".join(command)
        for fragment in (
            "--cpus 2.0", "--memory 4g", "--pids-limit 256", "--read-only",
            "--cap-drop ALL", "no-new-privileges", "--network exec-01-internal",
            "/workspace:rw,nosuid,nodev,noexec,size=2000000000,uid=65532,gid=65532,mode=0700",
        ):
            self.assertIn(fragment, rendered)
        self.assertNotIn("--storage-opt", command)
        self.assertNotIn("--mount", command)
        request_env = next(item for item in command if item.startswith("EXEC_REQUEST_B64="))
        self.assertEqual(json.loads(base64.b64decode(request_env.split("=", 1)[1])), request.as_dict())
        for forbidden in ("docker.sock", "OneDrive", "C:/Users", "github", "pfx", "token", "secret"):
            self.assertNotIn(forbidden.lower(), rendered.lower())
        self.assertEqual(command[-2:], ["sleep", "infinity"])


class ResourceBoundaryTests(unittest.TestCase):
    def test_tmpfs_workspace_must_leave_memory_headroom(self):
        """Catches a tmpfs quota that can consume the entire container memory limit."""
        with self.assertRaisesRegex(ValueError, "memory headroom"):
            containment(memory_limit="64m", workspace_limit_bytes=64 * 1024 * 1024)

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
            factory.destroy(workspace.path)
            self.assertFalse(workspace.path.exists())
            with self.assertRaisesRegex(WorkspaceError, "configured root"):
                factory.destroy(source)


class ContainerProviderRunnerTests(unittest.TestCase):
    def test_container_export_tar_rejects_traversal_and_symlink_pivot(self):
        """Catches a malicious workspace archive escaping its host extraction root."""
        policy = containment()
        job = DockerContainerJobRunner(policy)

        def archive_with(members):
            payload = io.BytesIO()
            with tarfile.open(fileobj=payload, mode="w") as archive:
                for member, content in members:
                    if content is not None:
                        member.size = len(content)
                        archive.addfile(member, io.BytesIO(content))
                    else:
                        archive.addfile(member)
            payload.seek(0)
            return payload

        traversal = tarfile.TarInfo("../escape.txt")
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(WorkspaceError, "unsafe path"):
            job._extract_workspace_archive(archive_with([(traversal, b"escape")]), Path(directory))

        pivot = tarfile.TarInfo("pivot")
        pivot.type = tarfile.SYMTYPE
        pivot.linkname = "../outside"
        nested = tarfile.TarInfo("pivot/escape.txt")
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(WorkspaceError, "invalid symlink"):
            job._extract_workspace_archive(
                archive_with([(pivot, None), (nested, b"escape")]), Path(directory)
            )

    def test_container_export_uses_an_existing_staging_root(self):
        """Catches export into an absent or ambiguous host destination."""
        class SuccessfulRunner:
            def run_raw(self, command, environment):
                return BoundedExecutionResult(0, b"{}", b"", None, 0.1, True)

        class AcceptingAttestor:
            def attest(self, executor_profile, policy):
                return None

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory, "workspace")
            workspace.mkdir()
            subprocess.run(["git", "init", "-q", str(workspace)], check=True)
            (workspace / "seed.txt").write_text("seed\n", encoding="utf-8")

            policy = containment()
            executor_profile = profile("codex")
            request = request_for(executor_profile)
            job = DockerContainerJobRunner(
                policy, runner=SuccessfulRunner(), network_attestor=AcceptingAttestor()
            )
            job._stream_workspace = lambda container, path: None
            job._remove_container = lambda container: None

            def export(container, destination):
                self.assertTrue(destination.is_dir())
                (destination / "result.txt").write_text("copied\n", encoding="utf-8")

            job._checked = lambda command: None
            job._export_workspace = export
            with patch(
                "hermes_steward.execution_isolation.build_executor_container_command",
                return_value=["docker", "create"],
            ):
                job.run_container(executor_profile, policy, request, str(workspace), {})
            self.assertEqual((workspace / "result.txt").read_text(encoding="utf-8"), "copied\n")
            self.assertTrue((workspace / ".git").is_dir())

    def test_provider_runner_uses_container_lifecycle_and_no_host_request_file(self):
        """Catches fallback to a host-owned request bind or direct docker run."""
        class FakeRunner:
            observed = None
            environment = None

            def run_container(self, profile, policy, request, workspace, environment):
                self.observed = (profile, policy, request, workspace)
                self.environment = environment
                raw = {
                    "status": "completed", "started_at": "2026-09-06T10:00:00Z",
                    "completed_at": "2026-09-06T10:00:01Z", "commands": [], "tests": [],
                    "changed_paths": [], "patch_digest": "1" * 64, "log_refs": [],
                }
                return BoundedExecutionResult(0, __import__("json").dumps(raw).encode(), b"", None, 0.1, True)

        fake = FakeRunner()
        executor_profile = profile("codex")
        request = request_for(executor_profile)
        request_root = Path(".test-request-files-must-not-exist")
        result = ContainerProviderRunner(containment(), request_root, runner=fake).invoke(
            executor_profile, request, "/srv/sandiva/workspaces/attempt-1"
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(fake.observed[0], executor_profile)
        self.assertEqual(fake.observed[2], request)
        self.assertNotIn("TOKEN", __import__("json").dumps(fake.environment).upper())
        self.assertFalse(request_root.exists())


if __name__ == "__main__":
    unittest.main()
