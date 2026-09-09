from __future__ import annotations

import unittest

from test_exec01_third_rework import authoritative_collector_fixture


class SixthReworkProfileBoundQualificationTests(unittest.TestCase):
    def test_validly_authenticated_probe_for_other_registered_profile_is_rejected_before_signing(self):
        baseline, profiles = authoritative_collector_fixture()
        self.assertIsNotNone(baseline.resolve())

        def substitute_with_claude_profile(probe):
            probe["profileFingerprint"] = profiles["claude-code"].fingerprint
            probe["evidenceContext"]["profileFingerprints"] = [profiles["claude-code"].fingerprint]

        collector, _ = authoritative_collector_fixture(mutate_probe=substitute_with_claude_profile)
        with self.assertRaisesRegex(SystemExit, "selected executor profile"):
            collector.collect_and_sign(profiles, b"sixth-rework-attestation-key-material")

    def test_reverse_cross_profile_substitution_is_rejected_before_signing(self):
        _, profiles = authoritative_collector_fixture()

        def substitute_with_codex_profile(probe):
            probe["profileFingerprint"] = profiles["codex"].fingerprint
            probe["evidenceContext"]["profileFingerprints"] = [profiles["codex"].fingerprint]

        collector, _ = authoritative_collector_fixture(
            mutate_probe=substitute_with_codex_profile,
            mutate_probe_provider="claude-code",
        )
        with self.assertRaisesRegex(SystemExit, "selected executor profile"):
            collector.collect_and_sign(profiles, b"sixth-rework-attestation-key-material")


if __name__ == "__main__":
    unittest.main()
