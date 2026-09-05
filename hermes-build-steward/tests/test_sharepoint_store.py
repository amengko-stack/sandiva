from __future__ import annotations

import json
import unittest

from helpers import build_task
from hermes_steward.codec import record_from_dict, record_to_dict
from hermes_steward.coordinator import Coordinator
from hermes_steward.sharepoint_store import SharePointListStateStore
from hermes_steward.store import StoreConflict
from test_state_and_leases import config


class FakeGraphTransport:
    def __init__(self):
        self.items = {}
        self.next_id = 1
        self.requests = []

    def request(self, method, url, headers, body=None):
        self.requests.append((method, url, dict(headers), body))
        self.assert_auth(headers)
        if method == "POST" and url.endswith("/items"):
            fields = json.loads(body)["fields"]
            if any(item["fields"]["TaskKey"] == fields["TaskKey"] for item in self.items.values()):
                return 409, {}, b'{"error":{"code":"nameAlreadyExists"}}'
            item_id = str(self.next_id)
            self.next_id += 1
            self.items[item_id] = {"version": 1, "fields": fields}
            return 201, {}, json.dumps(self._item(item_id)).encode()
        if method == "GET" and "/items?" in url:
            if "$filter=" in url:
                import re
                from urllib.parse import unquote

                decoded = unquote(url)
                match = re.search(r"TaskKey eq '([^']+)'", decoded)
                key = match.group(1).replace("''", "'") if match else None
                values = [self._item(item_id) for item_id, item in self.items.items() if item["fields"]["TaskKey"] == key]
            else:
                values = [self._item(item_id) for item_id in self.items]
            return 200, {}, json.dumps({"value": values}).encode()
        if method == "PATCH" and url.endswith("/fields"):
            item_id = url.split("/items/")[1].split("/")[0]
            item = self.items[item_id]
            if headers.get("If-Match") != f'"{item["version"]}"':
                return 412, {}, b'{"error":{"code":"preconditionFailed"}}'
            item["version"] += 1
            item["fields"].update(json.loads(body))
            return 200, {"ETag": f'"{item["version"]}"'}, json.dumps(item["fields"]).encode()
        raise AssertionError((method, url))

    @staticmethod
    def assert_auth(headers):
        if headers.get("Authorization") != "Bearer graph-token":
            raise AssertionError("missing token")

    def _item(self, item_id):
        item = self.items[item_id]
        return {"id": item_id, "eTag": f'"{item["version"]}"', "fields": item["fields"]}


class SharePointStateStoreTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeGraphTransport()
        self.endpoint = "https://graph.microsoft.com/v1.0/sites/site/lists/list"
        self.store = SharePointListStateStore(
            self.endpoint, "prod.tasks", "hermes-prod-vm", lambda: "graph-token",
            transport=self.transport,
        )

    def test_record_codec_round_trips_enums_datetimes_and_leases(self):
        coordinator = Coordinator(self.store, config())
        submitted = coordinator.submit_task(build_task())
        lease = coordinator.claim(build_task()["taskId"], 1, "worker-a", 30)
        restored = record_from_dict(record_to_dict(self.store.get(submitted.key).value))
        self.assertEqual(restored.status.value, "LEASED")
        self.assertEqual(restored.active_lease.fencing_token, lease.fencing_token)
        self.assertIsNotNone(restored.active_lease.lease_expires_at.tzinfo)

    def test_record_codec_rejects_corrupt_fingerprint_and_fence(self):
        coordinator = Coordinator(self.store, config())
        submitted = coordinator.submit_task(build_task())
        encoded = record_to_dict(submitted)
        encoded["taskFingerprint"] = "0" * 64
        with self.assertRaises(ValueError):
            record_from_dict(encoded)
        lease = coordinator.claim(build_task()["taskId"], 1, "worker-a", 30)
        encoded = record_to_dict(self.store.get(submitted.key).value)
        encoded["activeLease"]["fencingToken"] = lease.fencing_token + 1
        with self.assertRaises(ValueError):
            record_from_dict(encoded)

    def test_record_codec_rejects_wrong_key_and_impossible_counters(self):
        coordinator = Coordinator(self.store, config())
        submitted = coordinator.submit_task(build_task())
        encoded = record_to_dict(submitted)
        encoded["key"] = "prod.tasks:another-task:1"
        with self.assertRaises(ValueError):
            record_from_dict(encoded)
        encoded = record_to_dict(submitted)
        encoded["fencingCounter"] = 1
        with self.assertRaises(ValueError):
            record_from_dict(encoded)

    def test_create_get_and_cas_use_external_payload_and_if_match(self):
        coordinator = Coordinator(self.store, config())
        record = coordinator.submit_task(build_task())
        stored = self.store.get(record.key)
        stored.value.failure_history.append({"reason": "synthetic"})
        updated = self.store.compare_and_swap(record.key, stored.etag, stored.value)
        self.assertNotEqual(updated.etag, stored.etag)
        patch = [request for request in self.transport.requests if request[0] == "PATCH"][-1]
        self.assertEqual(patch[2]["If-Match"], stored.etag)
        self.assertNotIn("graph-token", patch[3])

    def test_stale_etag_fails_closed(self):
        coordinator = Coordinator(self.store, config())
        record = coordinator.submit_task(build_task())
        stored = self.store.get(record.key)
        self.store.compare_and_swap(record.key, stored.etag, stored.value)
        with self.assertRaises(StoreConflict):
            self.store.compare_and_swap(record.key, stored.etag, stored.value)

    def test_new_store_instance_recovers_same_durable_record(self):
        coordinator = Coordinator(self.store, config())
        record = coordinator.submit_task(build_task())
        second = coordinator.submit_task(build_task(taskId="HERMES-01-SYNTHETIC-002"))
        restarted_store = SharePointListStateStore(
            self.endpoint, "prod.tasks", "hermes-prod-vm", lambda: "graph-token",
            transport=self.transport,
        )
        self.assertEqual(restarted_store.get(record.key).value.task_fingerprint, record.task_fingerprint)
        self.assertEqual(restarted_store.get(second.key).value.task_fingerprint, second.task_fingerprint)
        self.assertEqual(len(restarted_store.list_records()), 2)

    def test_duplicate_unique_task_key_is_rejected(self):
        coordinator = Coordinator(self.store, config())
        record = coordinator.submit_task(build_task())
        with self.assertRaises(StoreConflict):
            self.store.create(record.key, record)

    def test_oversized_sharepoint_payload_fails_before_external_write(self):
        coordinator = Coordinator(self.store, config())
        record = coordinator.submit_task(build_task())
        etag = self.store.get(record.key).etag
        before = len(self.transport.requests)
        record.audit.append({"event": "oversized", "details": "x" * 60000})
        with self.assertRaisesRegex(ValueError, "60000"):
            self.store.compare_and_swap(record.key, etag, record)
        self.assertEqual(len(self.transport.requests), before + 1)


if __name__ == "__main__":
    unittest.main()
