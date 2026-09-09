from __future__ import annotations

import unittest

from test_exec01_third_rework import authoritative_collector_fixture


class FifthReworkQualificationProvenanceTests(unittest.TestCase):
    def assert_rejected(self, **fixture_options):
        collector, _ = authoritative_collector_fixture(**fixture_options)
        with self.assertRaises(SystemExit):
            collector.resolve()

    def test_all_green_fabricated_probe_from_other_run_and_head_is_rejected(self):
        self.assert_rejected(mutate_probe=lambda probe: probe.update(
            sourceIdentity="runtime-probe://other-run/other-head/fabricated",
        ))

    def test_cross_run_probe_is_rejected(self):
        self.assert_rejected(mutate_probe=lambda probe: (
            probe["evidenceContext"].update(runId="other-run"),
            probe.update(sourceIdentity=probe["sourceIdentity"].replace("q17-run", "other-run")),
        ))

    def test_cross_head_probe_is_rejected(self):
        self.assert_rejected(mutate_probe=lambda probe: (
            probe["evidenceContext"].update(headSha="0" * 40),
            probe.update(sourceIdentity=f"runtime-probe://q17-run/{'0' * 40}/{probe['attemptId']}/containment"),
        ))

    def test_nonexistent_supporting_fingerprint_is_rejected(self):
        self.assert_rejected(mutate_check=lambda check: check.update(
            supportingEvidenceFingerprints=["f" * 64],
        ))

    def test_arbitrary_hermes_origin_policy_fingerprint_is_rejected(self):
        self.assert_rejected(mutate_hermes=lambda hermes: hermes.update(
            originPolicyFingerprint="a" * 64,
        ))

    def test_forged_check_source_identity_is_rejected(self):
        self.assert_rejected(mutate_check=lambda check: check.update(
            sourceIdentity="https://executor.invalid/self-asserted-green",
        ))

    def test_forged_producer_identity_is_rejected_even_with_valid_record_hmac(self):
        self.assert_rejected(mutate_check=lambda check: check.update(
            producerIdentity="producer://attacker/self-asserted",
        ))

    def test_unresolvable_criterion_evidence_reference_is_rejected(self):
        self.assert_rejected(mutate_hermes=lambda hermes: hermes["criteriaResults"][0].update(
            evidenceReferences=["qualification-check://nonexistent"],
        ))

    def test_executor_origin_evidence_is_rejected(self):
        self.assert_rejected(mutate_probe=lambda probe: probe.update(
            origin="executor-self-assertion",
            sourceIdentity="executor://attempt/self-asserted-green",
        ))

    def test_ordinary_sha_rehash_cannot_replace_trusted_producer_attestation(self):
        def tamper(probe):
            probe["observations"]["networkPolicyEnforced"] = False
            probe["evidenceFingerprint"] = "f" * 64

        self.assert_rejected(tamper_probe=tamper)


if __name__ == "__main__":
    unittest.main()
