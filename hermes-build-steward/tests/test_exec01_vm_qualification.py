from __future__ import annotations

import unittest

from qualification.run_exec01_vm_qualification import REQUIRED_CHECKS, qualification_plan, verify_evidence
from test_execution_adapters import profile


class Exec01QualificationTests(unittest.TestCase):
    def setUp(self):
        self.profiles = {"codex": profile("codex"), "claude-code": profile("claude-code")}

    def test_plan_binds_both_exact_profiles_and_all_later_gate_checks(self):
        plan = qualification_plan(self.profiles)
        self.assertEqual(set(plan["profiles"]), {"codex", "claude-code"})
        self.assertEqual(plan["requiredChecks"], list(REQUIRED_CHECKS))
        self.assertTrue(plan["restrictions"]["draftPrOnly"])
        self.assertFalse(plan["restrictions"]["clientDocuments"])

    def test_evidence_requires_all_checks_exact_profile_fingerprints_and_unmerged_drafts(self):
        evidence = {
            "buildId": "EXEC-01", "classification": "synthetic-non-client",
            "profileFingerprints": {name: value.fingerprint for name, value in self.profiles.items()},
            "checks": {name: True for name in REQUIRED_CHECKS},
            "pullRequests": [
                {"provider": "codex", "isDraft": True, "merged": False},
                {"provider": "claude-code", "isDraft": True, "merged": False},
            ],
            "hermesDisposition": "PASS",
        }
        self.assertEqual(verify_evidence(self.profiles, evidence)["status"], "QUALIFIED")
        for mutation in ("checks", "profile", "merged", "client"):
            candidate = __import__("copy").deepcopy(evidence)
            if mutation == "checks":
                candidate["checks"][REQUIRED_CHECKS[0]] = False
            elif mutation == "profile":
                candidate["profileFingerprints"]["codex"] = "0" * 64
            elif mutation == "merged":
                candidate["pullRequests"][0]["merged"] = True
            else:
                candidate["classification"] = "client"
            with self.subTest(mutation=mutation), self.assertRaises(SystemExit):
                verify_evidence(self.profiles, candidate)


if __name__ == "__main__":
    unittest.main()
