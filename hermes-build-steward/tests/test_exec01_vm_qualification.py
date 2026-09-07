from __future__ import annotations

import copy
import unittest

from hermes_steward.contracts import fingerprint
from qualification.run_exec01_vm_qualification import (
    CONTRACT_SHA256,
    REQUIRED_CHECKS,
    qualification_plan,
    sign_evidence,
    verify_evidence,
)
from test_execution_adapters import profile


class Exec01QualificationTests(unittest.TestCase):
    def setUp(self):
        self.profiles = {"codex": profile("codex"), "claude-code": profile("claude-code")}
        self.key = b"trusted-hostinger-qualification-key-material"

    def _evidence(self):
        task = {"id": "EXEC-01-QUALIFICATION", "version": 2, "fingerprint": "1" * 64}
        records, pull_requests, probes = [], [], []
        for number, (provider, executor_profile) in enumerate(self.profiles.items(), start=1):
            attempt = f"attempt-{provider}"
            commit = str(number) * 40
            record = {
                "task": task,
                "attemptId": attempt,
                "leaseId": f"lease-{provider}",
                "fencingToken": number,
                "profileFingerprint": executor_profile.fingerprint,
                "baseSha": "9ef9143479090bedc698b77fa7bf2cbc70b37b16",
                "headSha": "a" * 40,
                "branch": f"build/exec-01-qualification-{provider}",
                "commitSha": commit,
                "draftPrNumber": 80 + number,
                "disposition": "EXECUTION_SUCCEEDED",
            }
            record["recordFingerprint"] = fingerprint(record)
            records.append(record)
            pull_requests.append({
                "provider": provider,
                "number": 80 + number,
                "head": record["branch"],
                "commitSha": commit,
                "base": "main",
                "isDraft": True,
                "merged": False,
                "checksReadbackFingerprint": ("b" if provider == "codex" else "c") * 64,
            })
            probes.append({
                "provider": provider,
                "attemptId": attempt,
                "taskFingerprint": task["fingerprint"],
                "profileFingerprint": executor_profile.fingerprint,
                "origin": "trusted-runtime-probe",
                "evidenceFingerprint": ("d" if provider == "codex" else "e") * 64,
            })
        unsigned = {
            "buildId": "EXEC-01",
            "contractSha256": CONTRACT_SHA256,
            "classification": "synthetic-non-client",
            "repository": "https://github.com/amengko-stack/sandiva",
            "baseSha": "9ef9143479090bedc698b77fa7bf2cbc70b37b16",
            "headSha": "a" * 40,
            "task": task,
            "profileFingerprints": {name: value.fingerprint for name, value in self.profiles.items()},
            "executionRecords": records,
            "pullRequestReadback": pull_requests,
            "containmentProbeEvidence": probes,
            "checks": {name: {"origin": "trusted-runtime-probe", "evidenceFingerprint": "f" * 64} for name in REQUIRED_CHECKS},
            "hermesEvidence": {
                "origin": "trusted-hermes-independent",
                "evidenceIdentity": "hermes://exec-01/qualification/final",
                "taskFingerprint": task["fingerprint"],
                "disposition": "PASS",
            },
            "restrictions": {
                "draftPrOnly": True, "merged": False, "deployment": False,
                "productionActivation": False, "clientDocuments": False,
            },
        }
        return sign_evidence(unsigned, self.key)

    def test_plan_binds_both_exact_profiles_and_all_later_gate_checks(self):
        plan = qualification_plan(self.profiles)
        self.assertEqual(set(plan["profiles"]), {"codex", "claude-code"})
        self.assertEqual(plan["requiredChecks"], list(REQUIRED_CHECKS))
        self.assertEqual(plan["contractSha256"], CONTRACT_SHA256)
        self.assertTrue(plan["restrictions"]["draftPrOnly"])
        self.assertFalse(plan["restrictions"]["clientDocuments"])

    def test_r8_only_signed_task_bound_records_and_readbacks_can_qualify(self):
        evidence = self._evidence()
        self.assertEqual(verify_evidence(self.profiles, evidence, attestation_key=self.key)["status"], "QUALIFIED")

        mutations = {
            "invented PR": lambda value: value["pullRequestReadback"].__setitem__(0, {**value["pullRequestReadback"][0], "number": 999}),
            "wrong commit": lambda value: value["executionRecords"][0].__setitem__("commitSha", "0" * 40),
            "wrong base": lambda value: value.__setitem__("baseSha", "0" * 40),
            "wrong task": lambda value: value["task"].__setitem__("fingerprint", "0" * 64),
            "wrong profile": lambda value: value["profileFingerprints"].__setitem__("codex", "0" * 64),
            "stale fence": lambda value: value["executionRecords"][0].__setitem__("fencingToken", 0),
            "duplicate result": lambda value: value["executionRecords"].append(copy.deepcopy(value["executionRecords"][0])),
            "self pass": lambda value: value["hermesEvidence"].__setitem__("origin", "executor-self-assertion"),
        }
        for label, mutate in mutations.items():
            candidate = copy.deepcopy(evidence)
            candidate.pop("attestation")
            mutate(candidate)
            candidate = sign_evidence(candidate, self.key)
            with self.subTest(label=label), self.assertRaises(SystemExit):
                verify_evidence(self.profiles, candidate, attestation_key=self.key)

        with self.assertRaises(SystemExit):
            verify_evidence(
                self.profiles,
                {"buildId": "EXEC-01", "checks": {name: True for name in REQUIRED_CHECKS}},
                attestation_key=self.key,
            )


if __name__ == "__main__":
    unittest.main()
