from __future__ import annotations

import json
import unittest

from helpers import build_task
from hermes_steward.audit import sanitize_audit_value
from hermes_steward.config import ConfigurationError, RuntimeConfig
from hermes_steward.coordinator import Coordinator
from hermes_steward.store import InMemoryStateStore


def hostinger_production_fields():
    return {
        "vmProvider": "hostinger",
        "graphAuthentication": {
            "provider": "entra-certificate",
            "tenantId": "tenant-id",
            "clientId": "client-id",
            "certificatePath": "/etc/sandiva-hermes/credentials/hermes-graph.pfx",
        },
    }


class EnvironmentSeparationTests(unittest.TestCase):
    def test_local_identity_cannot_address_production_namespace(self):
        with self.assertRaises(ConfigurationError):
            RuntimeConfig.from_mapping(
                {
                    "environmentKind": "development", "runtimeRole": "local-development",
                    "environmentId": "local", "taskNamespace": "prod.tasks", "leaseDomain": "prod.vm",
                    "workerIdentity": "local", "hermesVersion": "0.1.0",
                    "stateBackend": "memory-test-only", "stateEndpoint": "memory://test", "resultMaxBytes": 1024,
                }
            )

    def test_production_requires_vm_role_and_external_sharepoint_state(self):
        baseline = {
            "environmentKind": "production", "runtimeRole": "local-development",
            "environmentId": "hermes-prod-vm", "taskNamespace": "prod.tasks", "leaseDomain": "prod.vm",
            "workerIdentity": "vm-worker", "hermesVersion": "0.1.0",
            "stateBackend": "memory-test-only", "stateEndpoint": "memory://test", "resultMaxBytes": 1024,
            **hostinger_production_fields(),
        }
        with self.assertRaises(ConfigurationError):
            RuntimeConfig.from_mapping(baseline)
        good = dict(
            baseline, runtimeRole="authoritative-vm", stateBackend="sharepoint-list",
            stateEndpoint="https://graph.microsoft.com/v1.0/sites/site/lists/list", resultMaxBytes=8192,
        )
        self.assertEqual(RuntimeConfig.from_mapping(good).runtime_role, "authoritative-vm")

    def test_production_result_limit_preserves_room_for_task_and_audit_history(self):
        with self.assertRaisesRegex(ConfigurationError, "at most 8192"):
            RuntimeConfig.from_mapping(
                {
                    "environmentKind": "production", "runtimeRole": "authoritative-vm",
                    "environmentId": "hermes-prod-vm", "taskNamespace": "prod.tasks", "leaseDomain": "prod.vm",
                    "workerIdentity": "vm-worker", "hermesVersion": "0.1.0", "stateBackend": "sharepoint-list",
                    "stateEndpoint": "https://graph.microsoft.com/v1.0/sites/site/lists/list", "resultMaxBytes": 65536,
                    **hostinger_production_fields(),
                }
            )

    def test_production_rejects_windows_onedrive_and_file_endpoints(self):
        for endpoint in ("C:\\Users\\partner\\state", "file:///var/lib/hermes", "https://example/OneDrive/state"):
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(ConfigurationError):
                    RuntimeConfig.from_mapping(
                        {
                            "environmentKind": "production", "runtimeRole": "authoritative-vm",
                            "environmentId": "hermes-prod-vm", "taskNamespace": "prod.tasks", "leaseDomain": "prod.vm",
                            "workerIdentity": "vm-worker", "hermesVersion": "0.1.0",
                            "stateBackend": "sharepoint-list", "stateEndpoint": endpoint, "resultMaxBytes": 1024,
                            **hostinger_production_fields(),
                        }
                    )

    def test_production_state_endpoint_must_be_an_exact_graph_list_resource(self):
        for endpoint in (
            "https://graph.microsoft.com/v1.0/users",
            "https://graph.microsoft.com/v1.0/sites/site/lists/list/items",
            "https://graph.microsoft.com/v1.0/sites/{site-id}/lists/{list-id}",
            "https://graph.microsoft.com/beta/sites/site/lists/list",
        ):
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(ConfigurationError):
                    RuntimeConfig.from_mapping(
                        {
                            "environmentKind": "production", "runtimeRole": "authoritative-vm",
                            "environmentId": "hermes-prod-vm", "taskNamespace": "prod.tasks", "leaseDomain": "prod.vm",
                            "workerIdentity": "vm-worker", "hermesVersion": "0.1.0",
                            "stateBackend": "sharepoint-list", "stateEndpoint": endpoint, "resultMaxBytes": 1024,
                            **hostinger_production_fields(),
                        }
                    )

    def test_audit_redacts_secret_values_recursively(self):
        sentinel = "COORDINATOR-SECRET-SENTINEL"
        sanitized = sanitize_audit_value({"token": sentinel, "nested": {"clientSecret": sentinel}, "ok": "visible"})
        encoded = json.dumps(sanitized)
        self.assertNotIn(sentinel, encoded)
        self.assertEqual(sanitized["ok"], "visible")
        self.assertEqual(sanitize_audit_value({"fencingToken": 7})["fencingToken"], 7)

    def test_production_submission_requires_retrieved_canonical_bytes(self):
        production = RuntimeConfig.from_mapping(
            {
                "environmentKind": "production", "runtimeRole": "authoritative-vm",
                "environmentId": "hermes-prod-vm", "taskNamespace": "prod.tasks", "leaseDomain": "prod.vm",
                "workerIdentity": "vm-worker", "hermesVersion": "0.1.0", "stateBackend": "sharepoint-list",
                "stateEndpoint": "https://graph.microsoft.com/v1.0/sites/site/lists/list", "resultMaxBytes": 8192,
                **hostinger_production_fields(),
            }
        )
        coordinator = Coordinator(InMemoryStateStore(), production)
        with self.assertRaisesRegex(ValueError, "canonical bytes"):
            coordinator.submit_task(build_task())


class HealthTests(unittest.TestCase):
    def test_operator_health_contains_all_contract_fields(self):
        config = RuntimeConfig.from_mapping(
            {
                "environmentKind": "development", "runtimeRole": "local-development",
                "environmentId": "hermes-dev", "taskNamespace": "dev.tasks", "leaseDomain": "dev.local",
                "workerIdentity": "worker-dev", "hermesVersion": "0.1.0",
                "stateBackend": "memory-test-only", "stateEndpoint": "memory://test", "resultMaxBytes": 1024,
            }
        )
        coordinator = Coordinator(InMemoryStateStore(), config)
        coordinator.submit_task(build_task())
        health = coordinator.health()
        expected = {
            "hermesVersion", "configurationFingerprint", "environmentIdentity", "workerIdentity",
            "lastHeartbeat", "currentTask", "currentLease", "pendingTaskVisibility",
            "lastSuccessfulTask", "lastFailedTask", "dependencyHealth",
        }
        self.assertEqual(set(health), expected)
        self.assertEqual(health["pendingTaskVisibility"], 1)
        self.assertNotIn("stateEndpoint", health)

    def test_state_store_failure_is_reported_without_crashing_health(self):
        class FailedStore:
            def list_records(self):
                raise RuntimeError("sentinel backend failure")

        config = RuntimeConfig.from_mapping(
            {
                "environmentKind": "development", "runtimeRole": "local-development",
                "environmentId": "hermes-dev", "taskNamespace": "dev.tasks", "leaseDomain": "dev.local",
                "workerIdentity": "worker-dev", "hermesVersion": "0.1.0",
                "stateBackend": "memory-test-only", "stateEndpoint": "memory://test", "resultMaxBytes": 1024,
            }
        )
        health = Coordinator(FailedStore(), config).health()
        self.assertEqual(health["dependencyHealth"]["stateStore"], "UNHEALTHY")
        self.assertIsNone(health["currentTask"])
        self.assertNotIn("sentinel backend failure", json.dumps(health))


if __name__ == "__main__":
    unittest.main()
