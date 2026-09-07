from __future__ import annotations

import subprocess
import shutil
import unittest
import uuid
from pathlib import Path

from helpers import AC_BYTES, SPEC_BYTES
from hermes_steward.config import RuntimeConfig
from hermes_steward.coordinator import Coordinator
from hermes_steward.execution_coordinator import (
    ExecutionCoordinator,
    ExecutionStage,
    InMemoryExecutionRecordStore,
)
from hermes_steward.execution_isolation import ContainmentPolicy, GatewayNetworkBinding
from hermes_steward.execution_publisher import TrustedGitHubPublisher
from hermes_steward.execution_runtime import ExecutionRuntimeConfig, ProductionExecutionService
from hermes_steward.prepublication import ChangeSet
from hermes_steward.store import InMemoryStateStore
from test_execution_adapters import profile, request_for
from test_execution_publisher import InMemoryGitHubGateway
from test_execution_recovery import Adapter, Inspector, ResultSink, successful_result
from test_execution_task_contract import dispatch_task


def _source_repository(root: Path) -> tuple[Path, str]:
    source = root / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    subprocess.run(["git", "-C", str(source), "config", "user.email", "test@sandiva.invalid"], check=True)
    subprocess.run(["git", "-C", str(source), "config", "user.name", "Sandiva Test"], check=True)
    (source / "hermes-build-steward").mkdir()
    (source / "hermes-build-steward" / "README.md").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(source), "add", "hermes-build-steward/README.md"], check=True)
    subprocess.run(["git", "-C", str(source), "commit", "-q", "-m", "base"], check=True)
    base_sha = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    return source, base_sha


class Exec01RuntimeCompositionTests(unittest.TestCase):
    def test_r1_production_service_checkout_exact_base_and_reaches_real_adapter(self):
        """Catches broken production composition or an omitted trusted source repository."""
        # Keep below legacy Windows MAX_PATH so Git object paths do not turn
        # this cross-platform integration assertion into a path-length test.
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]
        root.mkdir(parents=True)
        try:
            source, base_sha = _source_repository(root)
            executor_profile = profile("codex")
            task = dispatch_task(taskId="EX1", baseRef=base_sha)
            task["dispatchPolicy"]["executorProfile"] = {
                "profileId": executor_profile.profile_id,
                "profileFingerprint": executor_profile.fingerprint,
            }
            task["dispatchPolicy"]["permittedFallbackProfiles"] = []
            task["dispatchPolicy"]["fallbackMode"] = "NONE"

            class BaseObservingRunner:
                observed_head = None
                calls = 0

                def invoke(self, observed_profile, observed_request, workspace):
                    self.calls += 1
                    self.asserted_profile = observed_profile
                    self.observed_head = subprocess.check_output(
                        ["git", "-C", workspace, "rev-parse", "HEAD"], text=True
                    ).strip()
                    (Path(workspace) / "hermes-build-steward" / "README.md").write_text(
                        "implemented\n", encoding="utf-8"
                    )
                    return {
                        "status": "completed",
                        "started_at": "2026-09-06T10:00:00+00:00",
                        "completed_at": "2026-09-06T10:00:01+00:00",
                        "commands": [], "tests": [], "log_refs": [],
                    }

            runner = BaseObservingRunner()
            policy = ContainmentPolicy(
                cpu_limit="1.0", memory_limit="128m", pids_limit=32,
                workspace_limit_bytes=16 * 1024 * 1024, wall_time_seconds=30,
                output_limit_bytes=65536, network_name="exec01-internal",
                allowed_endpoints=executor_profile.allowed_endpoints,
            )
            config = ExecutionRuntimeConfig(
                repository="https://github.com/amengko-stack/sandiva",
                source_repository_path=str(source), workspace_root=str(root / "workspaces"),
                execution_state_endpoint="https://graph.microsoft.com/v1.0/sites/site/lists/executions",
                execution_state_namespace="prod.exec01.executions",
                result_state_endpoint="https://graph.microsoft.com/v1.0/sites/site/lists/results",
                result_state_namespace="prod.exec01.results",
                profiles={"codex": executor_profile}, containment_policy=policy,
                gateway_binding=GatewayNetworkBinding(
                    "exec01-internal", "exec01-gateway",
                    "registry.example/gateway@sha256:" + "a" * 64,
                    policy.network_policy_fingerprint,
                ),
                github_repository="amengko-stack/sandiva",
                github_askpass_path="/opt/sandiva/bin/github-askpass",
            )
            hermes = Coordinator(
                InMemoryStateStore(),
                RuntimeConfig.from_mapping({
                    "environmentKind": "development", "runtimeRole": "local-development",
                    "environmentId": "exec01-test", "taskNamespace": "dev.exec01",
                    "leaseDomain": "dev.exec01", "workerIdentity": "exec01-worker",
                    "hermesVersion": "0.2.0", "stateBackend": "memory-test-only",
                    "stateEndpoint": "memory://exec01", "resultMaxBytes": 65536,
                }),
            )
            service = ProductionExecutionService(
                config, hermes, InMemoryExecutionRecordStore(), ResultSink(), runner,
                TrustedGitHubPublisher(InMemoryGitHubGateway()),
            )

            record = service.dispatch(task, SPEC_BYTES, AC_BYTES)

            self.assertEqual(record.stage, ExecutionStage.RESULT_PERSISTED)
            self.assertEqual(runner.calls, 1)
            self.assertEqual(runner.asserted_profile, executor_profile)
            self.assertEqual(runner.observed_head, base_sha)
            self.assertFalse(Path(record.workspace).exists())
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_r5_durable_result_uses_trusted_inspector_paths_and_digest(self):
        """Catches provider-owned changedPaths/patchDigest surviving durable commit."""
        request = request_for(profile("codex"))
        provider_result = successful_result(request)
        provider_result.update(changedPaths=[], patchDigest="2" * 64)
        trusted = ChangeSet(
            ("hermes-build-steward/README.md",),
            "1" * 64,
            10,
            (),
            (),
        )

        class TrustedInspector:
            def inspect(self, workspace, observed_request):
                del workspace
                self.assert_request = observed_request
                return trusted

        sink = ResultSink()
        coordinator = ExecutionCoordinator(
            InMemoryExecutionRecordStore(),
            type("Workspace", (), {"create": lambda self, request, source: type("W", (), {"path": Path("/workspace")})()})(),
            Adapter(provider_result),
            TrustedInspector(),
            TrustedGitHubPublisher(InMemoryGitHubGateway()),
            sink,
            lambda: None,
            source_repository=Path(__file__).parents[1],
        )

        record = coordinator.dispatch(request)

        self.assertEqual(record.execution_result["changedPaths"], list(trusted.changed_paths))
        self.assertEqual(record.execution_result["patchDigest"], trusted.patch_digest)
        self.assertEqual(sink.values[record.identity]["changedPaths"], list(trusted.changed_paths))
        self.assertEqual(sink.values[record.identity]["patchDigest"], trusted.patch_digest)

    def test_r5_workspace_drift_after_approval_is_denied_before_commit(self):
        """Catches post-inspection workspace drift being published under stale provenance."""
        request = request_for(profile("codex"))
        first = ChangeSet(("hermes-build-steward/README.md",), "1" * 64, 10, (), ())
        second = ChangeSet(("hermes-build-steward/README.md",), "2" * 64, 11, (), ())

        class DriftingInspector:
            def __init__(self):
                self.calls = 0

            def inspect(self, workspace, observed_request):
                del workspace, observed_request
                self.calls += 1
                return first if self.calls == 1 else second

        gateway = InMemoryGitHubGateway()
        coordinator = ExecutionCoordinator(
            InMemoryExecutionRecordStore(),
            type("Workspace", (), {"create": lambda self, request, source: type("W", (), {"path": Path("/workspace")})()})(),
            Adapter(successful_result(request)), DriftingInspector(),
            TrustedGitHubPublisher(gateway), ResultSink(), lambda: None,
            source_repository=Path(__file__).parents[1],
        )

        with self.assertRaisesRegex(RuntimeError, "changed after approval"):
            coordinator.dispatch(request)
        self.assertEqual(gateway.commit_calls, 0)


if __name__ == "__main__":
    unittest.main()
