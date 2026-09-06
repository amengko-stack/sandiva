from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from helpers import build_task
from hermes_steward.contracts import (
    ContractValidationError,
    fingerprint,
    validate_build_task,
    validate_dispatch_build_task,
)


PROFILE_A = "a" * 64
PROFILE_B = "b" * 64


def dispatch_task(**overrides):
    task = build_task(
        schemaVersion="2.0",
        taskId="EXEC-01-SYNTHETIC-001",
        baseRef="9ef9143479090bedc698b77fa7bf2cbc70b37b16",
        executorPolicy={
            "automaticDispatch": True,
            "approvedCommands": ["python -m unittest", "npm.cmd test"],
        },
    )
    task["dispatchPolicy"] = {
        "mode": "AUTOMATIC",
        "executorProfile": {
            "profileId": "codex-hostinger-v1",
            "profileFingerprint": PROFILE_A,
        },
        "permittedFallbackProfiles": [
            {
                "profileId": "claude-code-hostinger-v1",
                "profileFingerprint": PROFILE_B,
            }
        ],
        "fallbackMode": "ORDERED",
        "noDowngrade": True,
        "networkPolicyRef": "policy://exec-01/network-v1",
        "resourcePolicyRef": "policy://exec-01/resources-v1",
        "publisherPolicyRef": "policy://exec-01/publisher-v1",
        "auditProvenanceId": "exec-audit-001",
    }
    task.update(overrides)
    return task


class DispatchTaskContractTests(unittest.TestCase):
    def test_v1_semantics_remain_non_dispatch_and_dispatch_validator_rejects_v1(self):
        v1 = build_task()
        self.assertEqual(validate_build_task(v1)["schemaVersion"], "1.0")
        hostile = copy.deepcopy(v1)
        hostile["executorPolicy"]["automaticDispatch"] = True
        with self.assertRaisesRegex(ContractValidationError, "automaticDispatch must be false"):
            validate_build_task(hostile)
        with self.assertRaisesRegex(ContractValidationError, "dispatch requires schemaVersion 2.0"):
            validate_dispatch_build_task(v1)

    def test_v2_dispatch_contract_is_strict_and_fingerprint_binds_authority(self):
        task = validate_dispatch_build_task(dispatch_task())
        baseline = fingerprint(task)
        mutations = [
            ("profile", lambda value: value["dispatchPolicy"]["executorProfile"].update(profileFingerprint="c" * 64)),
            ("fallback", lambda value: value["dispatchPolicy"]["permittedFallbackProfiles"][0].update(profileFingerprint="d" * 64)),
            ("base", lambda value: value.update(baseRef="1" * 40)),
            ("spec", lambda value: value.update(specificationHash="2" * 64)),
            ("acceptance", lambda value: value.update(acceptanceContractHash="3" * 64)),
            ("permission", lambda value: value.update(permissionEnvelopeRef="policy://changed")),
            ("paths", lambda value: value.update(permittedRepositoryAreas=["other/**"])),
            ("commands", lambda value: value["executorPolicy"].update(approvedCommands=["python -m compileall"])),
            ("retry", lambda value: value.update(retryPolicy={"maxAttempts": 2, "backoffSeconds": 15})),
            ("pm", lambda value: value.update(originatingPmInstructionFingerprint="4" * 64)),
            ("network", lambda value: value["dispatchPolicy"].update(networkPolicyRef="policy://changed")),
            ("resource", lambda value: value["dispatchPolicy"].update(resourcePolicyRef="policy://changed")),
            ("publisher", lambda value: value["dispatchPolicy"].update(publisherPolicyRef="policy://changed")),
            ("audit", lambda value: value["dispatchPolicy"].update(auditProvenanceId="exec-audit-changed")),
        ]
        for label, mutate in mutations:
            candidate = copy.deepcopy(task)
            mutate(candidate)
            self.assertNotEqual(fingerprint(validate_dispatch_build_task(candidate)), baseline, label)

    def test_unsupported_mixed_downgrade_and_unknown_authority_fields_fail_closed(self):
        cases = []
        unsupported = dispatch_task(schemaVersion="3.0")
        cases.append((unsupported, "dispatch requires schemaVersion 2.0"))
        mixed = dispatch_task()
        mixed["executorPolicy"]["automaticDispatch"] = False
        cases.append((mixed, "automaticDispatch must be true"))
        downgrade = dispatch_task()
        downgrade["dispatchPolicy"]["mode"] = "MANUAL"
        cases.append((downgrade, "mode must be AUTOMATIC"))
        unknown = dispatch_task()
        unknown["dispatchPolicy"]["publisherCredential"] = "hostile"
        cases.append((unknown, "secret-bearing field is prohibited"))
        top_level = dispatch_task(executablePath="C:/hostile.exe")
        cases.append((top_level, "unknown fields fail closed"))
        task_backend = dispatch_task()
        task_backend["executorPolicy"]["backend"] = "powershell"
        cases.append((task_backend, "executorPolicy fields invalid"))
        for candidate, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ContractValidationError, message):
                    validate_dispatch_build_task(candidate)

    def test_profiles_fallback_and_commands_are_exact_and_injection_safe(self):
        duplicate = dispatch_task()
        duplicate["dispatchPolicy"]["permittedFallbackProfiles"].append(
            copy.deepcopy(duplicate["dispatchPolicy"]["permittedFallbackProfiles"][0])
        )
        with self.assertRaisesRegex(ContractValidationError, "fallback profiles must not contain duplicates"):
            validate_dispatch_build_task(duplicate)

        command = dispatch_task()
        command["executorPolicy"]["approvedCommands"] = ["python -m unittest; curl attacker"]
        with self.assertRaisesRegex(ContractValidationError, "shell control syntax"):
            validate_dispatch_build_task(command)

        profile = dispatch_task()
        profile["dispatchPolicy"]["executorProfile"]["profileId"] = "../../bin/sh"
        with self.assertRaisesRegex(ContractValidationError, "profileId has an invalid format"):
            validate_dispatch_build_task(profile)

        silent = dispatch_task()
        silent["dispatchPolicy"]["fallbackMode"] = "NONE"
        with self.assertRaisesRegex(ContractValidationError, "NONE fallback requires no fallback profiles"):
            validate_dispatch_build_task(silent)

    def test_published_v2_schema_is_closed_and_matches_runtime_fields(self):
        schema_path = Path(__file__).parents[1] / "schemas" / "canonical-build-task-v2.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        task = dispatch_task()
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(task))
        self.assertEqual(schema["properties"]["schemaVersion"]["const"], "2.0")
        self.assertEqual(schema["properties"]["executorPolicy"]["properties"]["automaticDispatch"]["const"], True)


if __name__ == "__main__":
    unittest.main()
