from __future__ import annotations

import json
import unittest

from hermes_steward.evidence import ControlTowerEvidenceReader, EvidenceAccessDenied, GitHubEvidenceReader


class FakeTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, headers, body=None):
        self.calls.append((method, url, dict(headers), body))
        return self.responses.pop(0)


class EvidenceClientTests(unittest.TestCase):
    def test_control_tower_reader_is_graph_read_only_and_host_allowlisted(self):
        transport = FakeTransport([(200, {}, b"canonical bytes")])
        reader = ControlTowerEvidenceReader(lambda: "graph-token", allowed_drive_ids={"drive"}, transport=transport)
        value = reader.read("https://graph.microsoft.com/v1.0/drives/drive/items/item/content")
        self.assertEqual(value, b"canonical bytes")
        method, _, headers, body = transport.calls[0]
        self.assertEqual(method, "GET")
        self.assertEqual(headers["Authorization"], "Bearer graph-token")
        self.assertIsNone(body)
        with self.assertRaises(EvidenceAccessDenied):
            reader.read("https://evil.example/steal")
        with self.assertRaises(EvidenceAccessDenied):
            reader.read("https://graph.microsoft.com/v1.0/drives/other/items/item/content")
        for reference in (
            "https://graph.microsoft.com/v1.0/drives/drive/items/item/children/other/content",
            "https://graph.microsoft.com/v1.0/drives/drive/items/item/content?download=1",
            "https://graph.microsoft.com/v1.0/drives/drive/items/item/content#fragment",
        ):
            with self.subTest(reference=reference):
                with self.assertRaises(EvidenceAccessDenied):
                    reader.read(reference)

    def test_github_reader_uses_only_immutable_read_endpoints(self):
        sha = "c59596559515efa6e088eff4024f90cdca5b3898"
        transport = FakeTransport(
            [
                (200, {}, json.dumps({"sha": sha}).encode()),
                (200, {}, json.dumps({"check_runs": [{"id": 1, "conclusion": "success", "head_sha": sha}]}).encode()),
            ]
        )
        reader = GitHubEvidenceReader(transport=transport)
        evidence = reader.commit_and_checks("https://github.com/amengko-stack/sandiva", sha)
        self.assertEqual(evidence["commit"]["sha"], sha)
        self.assertEqual(evidence["checks"]["check_runs"][0]["head_sha"], sha)
        self.assertTrue(all(call[0] == "GET" for call in transport.calls))
        self.assertTrue(all("/repos/amengko-stack/sandiva/commits/" in call[1] for call in transport.calls))

    def test_github_reader_rejects_non_github_repository(self):
        with self.assertRaises(EvidenceAccessDenied):
            GitHubEvidenceReader(transport=FakeTransport([])).commit_and_checks(
                "https://evil.example/repo", "c59596559515efa6e088eff4024f90cdca5b3898"
            )


if __name__ == "__main__":
    unittest.main()
