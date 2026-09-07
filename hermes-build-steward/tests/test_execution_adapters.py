from __future__ import annotations

import json
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path
from types import SimpleNamespace

from hermes_steward.contracts import ContractValidationError, fingerprint, validate_dispatch_build_task
from hermes_steward.execution_adapters import ClaudeCodeExecutionAdapter, CodexExecutionAdapter
from hermes_steward.execution_contracts import (
    ExecutionContractError,
    ExecutorProfile,
    ExecutorProfileRegistry,
    normalize_execution_request,
    validate_execution_result,
)
from test_execution_task_contract import dispatch_task


def profile(provider: str) -> ExecutorProfile:
    name = "codex" if provider == "codex" else "claude-code"
    launcher = "codex" if provider == "codex" else "claude"
    return ExecutorProfile(
        profile_id=f"{name}-hostinger-v1",
        provider=provider,
        runtime_name=f"{name}-cli",
        runtime_version="synthetic-1.0.0",
        model="synthetic-conformance-model",
        launcher_version="exec-01.1",
        executable_digest=("c" if provider == "codex" else "d") * 64,
        fixed_argv=(launcher, "--non-interactive", "--model", "synthetic-conformance-model"),
        image="registry.example/sandiva/executor@sha256:" + ("e" if provider == "codex" else "f") * 64,
        credential_mode="trusted-egress-gateway",
        gateway_endpoint="executor-gateway.sandiva.internal:8443",
        allowed_endpoints=("executor-gateway.sandiva.internal:8443", "registry.npmjs.org:443"),
    )


def request_for(executor_profile: ExecutorProfile):
    task = dispatch_task()
    task["dispatchPolicy"]["executorProfile"] = {
        "profileId": executor_profile.profile_id,
        "profileFingerprint": executor_profile.fingerprint,
    }
    task["dispatchPolicy"]["permittedFallbackProfiles"] = []
    task["dispatchPolicy"]["fallbackMode"] = "NONE"
    validated = validate_dispatch_build_task(task)
    lease = SimpleNamespace(attempt_id="attempt-exec-01", lease_id="lease-01", fencing_token=7)
    return normalize_execution_request(validated, fingerprint(validated), executor_profile, lease)


class SyntheticRunner:
    def __init__(self, provider: str, response: dict):
        self.provider = provider
        self.response = response

    def invoke(self, profile, request, workspace):
        del workspace
        if profile.provider != self.provider:
            raise AssertionError("wrong provider adapter invoked the runner")
        return dict(self.response)


class ExecutorProfileTests(unittest.TestCase):
    def test_registry_requires_allowlisted_id_and_exact_fingerprint(self):
        codex = profile("codex")
        claude = profile("claude-code")
        registry = ExecutorProfileRegistry([codex, claude])
        self.assertEqual(registry.resolve(codex.profile_id, codex.fingerprint), codex)
        with self.assertRaisesRegex(ExecutionContractError, "not allowlisted"):
            registry.resolve("../../bin/sh", codex.fingerprint)
        with self.assertRaisesRegex(ExecutionContractError, "fingerprint mismatch"):
            registry.resolve(codex.profile_id, "0" * 64)

    def test_profile_fingerprint_binds_runtime_model_launcher_and_fixed_invocation(self):
        baseline = profile("codex")
        mutations = {
            "runtime": {"runtime_version": "changed"},
            "model": {
                "model": "changed",
                "fixed_argv": ("codex", "--non-interactive", "--model", "changed"),
            },
            "launcher": {"launcher_version": "changed"},
            "executable": {"executable_digest": "1" * 64},
            "argv": {"fixed_argv": ("codex", "exec", "--dangerously-bypass", baseline.model)},
            "image": {"image": "registry.example/x@sha256:" + "2" * 64},
            "network": {"allowed_endpoints": ("executor-gateway.sandiva.internal:8443", "attacker.example:443")},
            "gateway": {
                "gateway_endpoint": "other-gateway.sandiva.internal:8443",
                "allowed_endpoints": ("other-gateway.sandiva.internal:8443", "registry.npmjs.org:443"),
            },
        }
        for label, changed in mutations.items():
            candidate = ExecutorProfile(**{**baseline.as_dict(), **changed})
            self.assertNotEqual(candidate.fingerprint, baseline.fingerprint, label)


class NormalizedContractTests(unittest.TestCase):
    def test_request_is_frozen_task_derived_and_complete(self):
        codex = profile("codex")
        request = request_for(codex)
        with self.assertRaises(FrozenInstanceError):
            request.task_id = "changed"
        value = request.as_dict()
        self.assertEqual(value["schemaVersion"], "1.0")
        self.assertEqual(value["baseSha"], "9ef9143479090bedc698b77fa7bf2cbc70b37b16")
        self.assertEqual(value["executorProfile"]["profileFingerprint"], codex.fingerprint)
        self.assertEqual(value["lease"], {"leaseId": "lease-01", "fencingToken": 7})
        self.assertEqual(value["fallbackPolicy"]["mode"], "NONE")
        self.assertEqual(value["networkPolicyRef"], "policy://exec-01/network-v1")
        self.assertEqual(value["resourcePolicyRef"], "policy://exec-01/resources-v1")
        self.assertEqual(value["publisherPolicyRef"], "policy://exec-01/publisher-v1")
        self.assertEqual(value["auditProvenanceId"], "exec-audit-001")
        self.assertNotIn("executablePath", json.dumps(value))

    def test_codex_and_claude_normalize_to_the_same_stable_contract(self):
        codex = profile("codex")
        claude = profile("claude-code")
        codex_raw = {
            "status": "completed",
            "started_at": "2026-09-06T10:00:00+00:00",
            "completed_at": "2026-09-06T10:01:00+00:00",
            "commands": ["python -m unittest"],
            "tests": [{"name": "unit", "status": "PASS", "command": "python -m unittest"}],
            "changed_paths": ["hermes-build-steward/README.md"],
            "patch_digest": "1" * 64,
            "log_refs": ["evidence://codex/log-1"],
        }
        claude_raw = {
            "stop_reason": "end_turn",
            "startedAt": "2026-09-06T10:00:00+00:00",
            "completedAt": "2026-09-06T10:01:00+00:00",
            "commandsExecuted": ["python -m unittest"],
            "testOutcomes": [{"name": "unit", "status": "PASS", "command": "python -m unittest"}],
            "changedPaths": ["hermes-build-steward/README.md"],
            "patchDigest": "1" * 64,
            "evidenceReferences": ["evidence://claude/log-1"],
        }
        codex_request = request_for(codex)
        claude_request = request_for(claude)
        first = CodexExecutionAdapter(codex, SyntheticRunner("codex", codex_raw)).execute(codex_request, "/workspace")
        second = ClaudeCodeExecutionAdapter(claude, SyntheticRunner("claude-code", claude_raw)).execute(claude_request, "/workspace")
        self.assertEqual(set(first), set(second))
        self.assertEqual(first["disposition"], "EXECUTION_SUCCEEDED")
        self.assertEqual(second["disposition"], "EXECUTION_SUCCEEDED")
        self.assertNotIn("status", first)
        self.assertNotIn("stop_reason", second)
        self.assertEqual(first["provenance"]["runtimeVersion"], "synthetic-1.0.0")
        self.assertEqual(second["provenance"]["runtimeVersion"], "synthetic-1.0.0")

    def test_provider_diff_claims_are_discarded_until_trusted_inspection(self):
        """Catches omitted, understated, overstated, or forged provider diff provenance."""
        executor_profile = profile("codex")
        request = request_for(executor_profile)
        variants = (
            {},
            {"changed_paths": [], "patch_digest": None},
            {"changed_paths": ["hermes-build-steward/README.md"], "patch_digest": "0" * 64},
            {"changed_paths": [".github/workflows/hostile.yml"], "patch_digest": "not-a-digest"},
        )
        common = {
            "status": "completed",
            "started_at": "2026-09-06T10:00:00+00:00",
            "completed_at": "2026-09-06T10:00:01+00:00",
            "commands": [],
            "tests": [],
            "log_refs": [],
        }
        for claims in variants:
            with self.subTest(claims=claims):
                normalized = CodexExecutionAdapter(
                    executor_profile,
                    SyntheticRunner("codex", {**common, **claims}),
                ).execute(request, "/workspace")
                self.assertEqual(normalized["changedPaths"], [])
                self.assertIsNone(normalized["patchDigest"])

    def test_result_rejects_provider_shapes_malformed_identity_and_self_acceptance(self):
        codex = profile("codex")
        request = request_for(codex)
        valid = CodexExecutionAdapter(
            codex,
            SyntheticRunner("codex", {
                "status": "failed", "started_at": "2026-09-06T10:00:00+00:00",
                "completed_at": "2026-09-06T10:00:01+00:00", "commands": [], "tests": [],
                "changed_paths": [], "patch_digest": None, "log_refs": [], "error_type": "provider_unavailable",
            }),
        ).execute(request, "/workspace")
        for mutation in (
            {"stop_reason": "end_turn"},
            {"taskFingerprint": "0" * 64},
            {"HermesPass": True},
            {"disposition": "PASS"},
            {"changedPaths": [".github/workflows/hostile.yml"]},
            {"branch": "build/forged", "commitSha": "1" * 40,
             "draftPr": {"number": 1, "url": "https://github.com/amengko-stack/sandiva/pull/1", "isDraft": True}},
        ):
            candidate = {**valid, **mutation}
            with self.subTest(mutation=mutation):
                with self.assertRaises(ExecutionContractError):
                    validate_execution_result(candidate, request)

    def test_published_request_and_result_schemas_match_runtime_fields(self):
        base = Path(__file__).parents[1] / "schemas"
        request_schema = json.loads((base / "normalized-execution-request-v1.schema.json").read_text(encoding="utf-8"))
        result_schema = json.loads((base / "normalized-execution-result-v1.schema.json").read_text(encoding="utf-8"))
        codex = profile("codex")
        request = request_for(codex).as_dict()
        result = CodexExecutionAdapter(
            codex,
            SyntheticRunner("codex", {
                "status": "completed", "started_at": "2026-09-06T10:00:00+00:00",
                "completed_at": "2026-09-06T10:00:01+00:00", "commands": [], "tests": [],
                "changed_paths": [], "patch_digest": "1" * 64, "log_refs": [],
            }),
        ).execute(request_for(codex), "/workspace")
        self.assertEqual(set(request_schema["required"]), set(request))
        self.assertEqual(set(result_schema["required"]), set(result))
        self.assertFalse(request_schema["additionalProperties"])
        self.assertFalse(result_schema["additionalProperties"])


if __name__ == "__main__":
    unittest.main()
