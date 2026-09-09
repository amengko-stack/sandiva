from __future__ import annotations

import unittest
import shutil
import subprocess
import uuid
from pathlib import Path

from hermes_steward.cli import build_parser
from hermes_steward.execution_runtime import (
    ExecutionRuntimeConfig,
    ExecutionRuntimeConfigurationError,
    _verify_source_repository,
)
from test_execution_adapters import profile


def runtime_mapping():
    value = {
        "repository": "https://github.com/amengko-stack/sandiva",
        "sourceRepositoryPath": "/srv/sandiva/source/sandiva.git",
        "workspaceRoot": "/srv/sandiva/exec01/workspaces",
        "executionStateEndpoint": "https://graph.microsoft.com/v1.0/sites/site/lists/execution-state",
        "executionStateNamespace": "prod.exec01.executions",
        "resultStateEndpoint": "https://graph.microsoft.com/v1.0/sites/site/lists/execution-results",
        "resultStateNamespace": "prod.exec01.results",
        "executorProfiles": {
            "codex": profile("codex").as_dict(),
            "claude-code": profile("claude-code").as_dict(),
        },
        "containmentPolicy": {
            "cpuLimit": "2.0", "memoryLimit": "4g", "pidsLimit": 256,
            "workspaceLimitBytes": 2000000000, "wallTimeSeconds": 3600,
            "outputLimitBytes": 65536, "networkName": "exec01-internal",
            "allowedEndpoints": ["executor-gateway.sandiva.internal:8443", "registry.npmjs.org:443"],
        },
        "gatewayBinding": {
            "networkName": "exec01-internal", "containerName": "exec01-gateway",
            "image": "registry.example/sandiva/gateway@sha256:" + "a" * 64,
            "policyFingerprint": "b" * 64,
        },
        "githubPublisher": {
            "repository": "amengko-stack/sandiva",
            "askpassPath": "/opt/sandiva/bin/github-askpass",
        },
    }
    policy = ExecutionRuntimeConfig.__annotations__  # keep expected data independent of config parser
    del policy
    from hermes_steward.execution_isolation import ContainmentPolicy
    raw = value["containmentPolicy"]
    value["gatewayBinding"]["policyFingerprint"] = ContainmentPolicy(
        cpu_limit=raw["cpuLimit"], memory_limit=raw["memoryLimit"], pids_limit=raw["pidsLimit"],
        workspace_limit_bytes=raw["workspaceLimitBytes"], wall_time_seconds=raw["wallTimeSeconds"],
        output_limit_bytes=raw["outputLimitBytes"], network_name=raw["networkName"],
        allowed_endpoints=tuple(raw["allowedEndpoints"]),
    ).network_policy_fingerprint
    for configured in value["executorProfiles"].values():
        configured["gateway_policy_digest"] = value["gatewayBinding"]["policyFingerprint"]
        configured["gateway_implementation_digest"] = "a" * 64
    return value


class ExecutionRuntimeTests(unittest.TestCase):
    def test_production_execution_config_binds_all_real_runtime_dependencies(self):
        """Catches an ad hoc composition with absent profiles, stores, network or publisher."""
        config = ExecutionRuntimeConfig.from_mapping(runtime_mapping())
        self.assertEqual(config.repository, "https://github.com/amengko-stack/sandiva")
        self.assertEqual(set(config.profiles), {"codex", "claude-code"})
        self.assertEqual(config.gateway_binding.network_name, config.containment_policy.network_name)
        self.assertEqual(config.github_repository, "amengko-stack/sandiva")

        for missing in ("executorProfiles", "containmentPolicy", "gatewayBinding", "githubPublisher"):
            candidate = runtime_mapping()
            candidate.pop(missing)
            with self.subTest(missing=missing), self.assertRaises(ExecutionRuntimeConfigurationError):
                ExecutionRuntimeConfig.from_mapping(candidate)

    def test_cli_exposes_explicit_exec_dispatch_and_resume_without_activation(self):
        """Catches EXEC-01 requiring ad hoc Python assembly."""
        parser = build_parser()
        dispatch = parser.parse_args([
            "exec-dispatch", "--config", "hermes.json", "--execution-config", "exec.json",
            "--task", "task.json", "--pm-instruction", "pm.md", "--specification", "spec.md", "--acceptance-contract", "contract.md",
        ])
        resume = parser.parse_args([
            "exec-resume", "--config", "hermes.json", "--execution-config", "exec.json", "--task", "task.json",
            "--pm-instruction", "pm.md", "--specification", "spec.md", "--acceptance-contract", "contract.md",
        ])
        cancel = parser.parse_args([
            "exec-cancel", "--config", "hermes.json", "--execution-config", "exec.json", "--task", "task.json",
            "--pm-instruction", "pm.md", "--specification", "spec.md", "--acceptance-contract", "contract.md",
        ])
        self.assertEqual(dispatch.command, "exec-dispatch")
        self.assertEqual(resume.command, "exec-resume")
        self.assertEqual(cancel.command, "exec-cancel")

    def test_trusted_source_repository_must_have_the_exact_approved_origin(self):
        """Catches a configured path pointing to an unrelated repository with a matching commit object."""
        root = Path.cwd() / ".test-work" / str(uuid.uuid4())
        repository = root / "source"
        repository.mkdir(parents=True)
        try:
            subprocess.run(["git", "init", "-q", str(repository)], check=True)
            subprocess.run([
                "git", "-C", str(repository), "remote", "add", "origin",
                "https://github.com/amengko-stack/sandiva.git",
            ], check=True)
            _verify_source_repository(repository, "https://github.com/amengko-stack/sandiva")
            subprocess.run([
                "git", "-C", str(repository), "remote", "set-url", "origin",
                "https://github.com/attacker/unrelated.git",
            ], check=True)
            with self.assertRaisesRegex(ExecutionRuntimeConfigurationError, "approved repository"):
                _verify_source_repository(repository, "https://github.com/amengko-stack/sandiva")
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
