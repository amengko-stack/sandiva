from __future__ import annotations

import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

from hermes_steward.coordinator import Coordinator
from hermes_steward.health_server import create_health_server
from hermes_steward.store import InMemoryStateStore
from test_state_and_leases import config


class HealthServerTests(unittest.TestCase):
    def test_non_loopback_binding_is_rejected(self):
        with self.assertRaises(ValueError):
            create_health_server(Coordinator(InMemoryStateStore(), config()), "0.0.0.0", 0)

    def test_loopback_health_endpoint_is_operator_visible_and_read_only(self):
        server = create_health_server(Coordinator(InMemoryStateStore(), config()), "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            host, port = server.server_address
            with urlopen(f"http://{host}:{port}/healthz", timeout=2) as response:
                payload = json.loads(response.read())
            self.assertEqual(payload["environmentIdentity"], "hermes-dev-local")
            self.assertIn("dependencyHealth", payload)
            try:
                urlopen(f"http://{host}:{port}/tasks", timeout=2)
            except HTTPError as error:
                self.assertEqual(error.code, 404)
                error.close()
            else:
                self.fail("non-health endpoint unexpectedly succeeded")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
