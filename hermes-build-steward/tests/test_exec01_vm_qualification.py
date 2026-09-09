from __future__ import annotations

import copy
import unittest

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
        from test_exec01_third_rework import authoritative_collector_fixture
        collector, _ = authoritative_collector_fixture()
        return collector.collect_and_sign(self.profiles, self.key)

    @staticmethod
    def _resolver(evidence):
        unsigned = {key: value for key, value in evidence.items() if key != "attestation"}
        class Resolver:
            def resolve(self):
                value = copy.deepcopy(unsigned)
                value.pop("profileFingerprints", None)
                return value
        return Resolver()

    def test_plan_binds_both_exact_profiles_and_all_later_gate_checks(self):
        plan = qualification_plan(self.profiles)
        self.assertEqual(set(plan["profiles"]), {"codex", "claude-code"})
        self.assertEqual(plan["requiredChecks"], list(REQUIRED_CHECKS))
        self.assertEqual(plan["contractSha256"], CONTRACT_SHA256)
        self.assertTrue(plan["restrictions"]["draftPrOnly"])
        self.assertFalse(plan["restrictions"]["clientDocuments"])

    def test_r8_only_signed_task_bound_records_and_readbacks_can_qualify(self):
        evidence = self._evidence()
        self.assertEqual(verify_evidence(
            self.profiles, evidence, attestation_key=self.key,
            trusted_resolver=self._resolver(evidence),
        )["status"], "CODE_QA_EVIDENCE_VERIFIED")

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
                verify_evidence(
                    self.profiles, candidate, attestation_key=self.key,
                    trusted_resolver=self._resolver(evidence),
                )

        with self.assertRaises(SystemExit):
            verify_evidence(
                self.profiles,
                {"buildId": "EXEC-01", "checks": {name: True for name in REQUIRED_CHECKS}},
                attestation_key=self.key, trusted_resolver=self._resolver(evidence),
            )

    def test_hermes_non_pass_missing_wrong_task_or_executor_origin_never_qualifies(self):
        baseline = self._evidence()
        mutations = {
            "FAIL": lambda value: value["hermesEvidence"].update(disposition="FAIL"),
            "unresolved": lambda value: value["hermesEvidence"].update(disposition="UNRESOLVED"),
            "missing": lambda value: value.pop("hermesEvidence"),
            "wrong task": lambda value: value["hermesEvidence"]["task"].update(fingerprint="0" * 64),
            "executor supplied": lambda value: value["hermesEvidence"].update(origin="executor-self-assertion"),
        }
        for label, mutate in mutations.items():
            candidate = copy.deepcopy(baseline)
            candidate.pop("attestation")
            mutate(candidate)
            candidate = sign_evidence(candidate, self.key)
            with self.subTest(label=label), self.assertRaises(SystemExit):
                verify_evidence(
                    self.profiles, candidate, attestation_key=self.key,
                    trusted_resolver=self._resolver(candidate),
                )


if __name__ == "__main__":
    unittest.main()
