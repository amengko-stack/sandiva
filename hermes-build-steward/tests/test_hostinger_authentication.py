from __future__ import annotations

import json
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from helpers import AC_BYTES, SPEC_BYTES, build_task, normalized_result
from hermes_steward import identity
from hermes_steward.audit import sanitize_audit_value
from hermes_steward.config import ConfigurationError, RuntimeConfig
from hermes_steward.cli import _production_coordinator
from hermes_steward.contracts import ContractValidationError, validate_build_task
from hermes_steward.coordinator import Coordinator
from hermes_steward.isolation import IsolationPolicy, build_docker_command, sanitized_job_environment
from hermes_steward.results import ResultValidationError, validate_job_result
from hermes_steward.sharepoint_store import SharePointListStateStore
from hermes_steward.store import InMemoryStateStore


GRAPH_SCOPE = "https://graph.microsoft.com/.default"


def production_config(*, vm_provider: str = "hostinger", auth_provider: str = "entra-certificate") -> dict:
    authentication = {
        "provider": auth_provider,
        "tenantId": "11111111-1111-1111-1111-111111111111",
        "clientId": "22222222-2222-2222-2222-222222222222",
        "certificatePath": "/etc/sandiva-hermes/credentials/hermes-graph.pfx",
    }
    if auth_provider == "azure-managed-identity":
        authentication = {
            "provider": auth_provider,
            "clientId": "22222222-2222-2222-2222-222222222222",
        }
    return {
        "environmentKind": "production",
        "runtimeRole": "authoritative-vm",
        "vmProvider": vm_provider,
        "graphAuthentication": authentication,
        "environmentId": "hermes-prod-hostinger",
        "taskNamespace": "prod.build-steward.phase1",
        "leaseDomain": "prod.hermes-vm",
        "workerIdentity": "hermes-hostinger-worker-01",
        "hermesVersion": "0.1.0",
        "stateBackend": "sharepoint-list",
        "stateEndpoint": "https://graph.microsoft.com/v1.0/sites/site/lists/list",
        "resultMaxBytes": 8192,
    }


def secure_certificate(directory: str, content: bytes = b"synthetic-pkcs12") -> Path:
    path = Path(directory, "hermes-graph.pfx")
    path.write_bytes(content)
    if os.name == "posix":
        path.chmod(0o600)
    return path


def qualification_module():
    script_path = Path(__file__).parents[1] / "qualification" / "run_vm_qualification.py"
    spec = importlib.util.spec_from_file_location("hostinger_auth_qualification", script_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HostingerAuthenticationTests(unittest.TestCase):
    def test_ha01_certificate_provider_uses_app_only_identity_and_graph_default_scope(self):
        provider_type = getattr(identity, "EntraCertificateTokenProvider", None)
        self.assertIsNotNone(provider_type, "certificate Graph token provider is missing")
        observed = {}

        class Application:
            def acquire_token_for_client(self, *, scopes):
                observed["scopes"] = scopes
                return {"access_token": "opaque-process-token", "expires_in": 3599}

        def application_factory(**kwargs):
            observed["application"] = kwargs
            return Application()

        with tempfile.TemporaryDirectory() as directory:
            certificate = secure_certificate(directory)
            provider = provider_type(
                tenant_id="11111111-1111-1111-1111-111111111111",
                client_id="22222222-2222-2222-2222-222222222222",
                certificate_path=str(certificate),
                application_factory=application_factory,
            )
            self.assertEqual(provider(), "opaque-process-token")

        self.assertEqual(observed["scopes"], [GRAPH_SCOPE])
        self.assertEqual(
            observed["application"],
            {
                "client_id": "22222222-2222-2222-2222-222222222222",
                "authority": "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111",
                "client_credential": {"private_key_pfx_path": str(certificate)},
                "enable_pii_log": False,
            },
        )

    def test_ha02_certificate_and_token_material_are_excluded_from_tasks_results_audit_and_repr(self):
        certificate_sentinel = "/etc/sandiva-hermes/credentials/HOSTINGER-CERTIFICATE-SENTINEL.pfx"
        task = build_task()
        task["auditMetadata"]["certificatePath"] = certificate_sentinel
        with self.assertRaises(ContractValidationError):
            validate_build_task(task)
        task = build_task()
        task["auditMetadata"]["private.key"] = "PRIVATE-MATERIAL-SENTINEL"
        with self.assertRaises(ContractValidationError):
            validate_build_task(task)

        clean_task = build_task()
        lease = SimpleNamespace(attempt_id="attempt-1", worker_id="worker-1", lease_id="lease-1", fencing_token=3)
        result = normalized_result(clean_task, lease)
        result["deterministicEvidence"][0]["details"]["certificatePath"] = certificate_sentinel
        with self.assertRaises(ResultValidationError):
            validate_job_result(json.dumps(result).encode(), clean_task, lease, 65536)

        sanitized = sanitize_audit_value({"certificatePath": certificate_sentinel, "graphToken": "TOKEN-SENTINEL"})
        self.assertEqual(sanitized, {"certificatePath": "[REDACTED]", "graphToken": "[REDACTED]"})
        sanitized = sanitize_audit_value({"private-key": "PRIVATE-MATERIAL-SENTINEL"})
        self.assertEqual(sanitized, {"private-key": "[REDACTED]"})

        provider_type = getattr(identity, "EntraCertificateTokenProvider", None)
        self.assertIsNotNone(provider_type, "certificate Graph token provider is missing")
        with tempfile.TemporaryDirectory() as directory:
            certificate = secure_certificate(directory, b"PRIVATE-MATERIAL-SENTINEL")
            provider = provider_type(
                tenant_id="tenant", client_id="client", certificate_path=str(certificate),
                application_factory=lambda **_: SimpleNamespace(
                    acquire_token_for_client=lambda **__: {"access_token": "TOKEN-SENTINEL"}
                ),
            )
            encoded = repr(provider)
            self.assertNotIn("PRIVATE-MATERIAL-SENTINEL", encoded)
            self.assertNotIn("TOKEN-SENTINEL", encoded)

    def test_ha03_missing_certificate_fails_closed(self):
        provider_type = getattr(identity, "EntraCertificateTokenProvider", None)
        self.assertIsNotNone(provider_type, "certificate Graph token provider is missing")
        with self.assertRaisesRegex(RuntimeError, "certificate credential is unavailable"):
            provider_type(
                tenant_id="tenant", client_id="client", certificate_path="/missing/hermes-graph.pfx",
                application_factory=lambda **_: None,
            )

    def test_ha04_empty_or_non_file_certificate_fails_closed(self):
        provider_type = getattr(identity, "EntraCertificateTokenProvider", None)
        self.assertIsNotNone(provider_type, "certificate Graph token provider is missing")
        with tempfile.TemporaryDirectory() as directory:
            empty = secure_certificate(directory, b"")
            with self.assertRaisesRegex(RuntimeError, "certificate credential is invalid"):
                provider_type(
                    tenant_id="tenant", client_id="client", certificate_path=str(empty),
                    application_factory=lambda **_: None,
                )
            with self.assertRaisesRegex(RuntimeError, "certificate credential is invalid"):
                provider_type(
                    tenant_id="tenant", client_id="client", certificate_path=directory,
                    application_factory=lambda **_: None,
                )
            unreadable = secure_certificate(directory, b"synthetic-pkcs12")
            if os.name == "posix":
                unreadable.chmod(0o000)
                try:
                    with self.assertRaisesRegex(RuntimeError, "permissions are unsafe|credential is unreadable"):
                        provider_type(
                            tenant_id="tenant", client_id="client", certificate_path=str(unreadable),
                            application_factory=lambda **_: None,
                        )
                finally:
                    unreadable.chmod(0o600)
            else:
                with patch("hermes_steward.identity.os.access", return_value=False):
                    with self.assertRaisesRegex(RuntimeError, "credential is unreadable"):
                        provider_type(
                            tenant_id="tenant", client_id="client", certificate_path=str(unreadable),
                            application_factory=lambda **_: None,
                        )
            malformed = secure_certificate(directory, b"not-a-valid-pkcs12-container")
            with self.assertRaisesRegex(RuntimeError, "Microsoft identity client initialization failed"):
                provider_type(
                    tenant_id="tenant", client_id="client", certificate_path=str(malformed),
                    application_factory=lambda **_: (_ for _ in ()).throw(ValueError("private bytes must not leak")),
                )

    def test_ha05_unsupported_authentication_provider_fails_closed(self):
        raw = production_config(auth_provider="client-secret")
        with self.assertRaisesRegex(ConfigurationError, "unsupported graph authentication provider"):
            RuntimeConfig.from_mapping(raw)

    def test_ha06_azure_managed_identity_remains_an_independent_provider(self):
        provider_type = getattr(identity, "AzureManagedIdentityTokenProvider", None)
        builder = getattr(identity, "build_graph_token_provider", None)
        self.assertIsNotNone(provider_type, "Azure managed identity adapter is missing")
        self.assertIsNotNone(builder, "provider-neutral Graph token builder is missing")
        config = RuntimeConfig.from_mapping(
            production_config(vm_provider="azure", auth_provider="azure-managed-identity")
        )
        provider = builder(
            config.graph_authentication,
            azure_transport=lambda *_: json.dumps({"access_token": "azure-token"}).encode(),
        )
        self.assertIsInstance(provider, provider_type)
        self.assertEqual(provider(), "azure-token")

    def test_ha07_hostinger_production_requires_certificate_provider(self):
        config = RuntimeConfig.from_mapping(production_config())
        self.assertEqual(config.vm_provider, "hostinger")
        self.assertEqual(config.graph_authentication.provider, "entra-certificate")
        self.assertEqual(config.graph_authentication.tenant_id, "11111111-1111-1111-1111-111111111111")
        self.assertEqual(config.graph_authentication.client_id, "22222222-2222-2222-2222-222222222222")
        changed = production_config()
        changed["graphAuthentication"]["clientId"] = "33333333-3333-3333-3333-333333333333"
        self.assertNotEqual(config.fingerprint, RuntimeConfig.from_mapping(changed).fingerprint)
        with self.assertRaisesRegex(ConfigurationError, "Hostinger production requires entra-certificate"):
            RuntimeConfig.from_mapping(
                production_config(vm_provider="hostinger", auth_provider="azure-managed-identity")
            )
        escaped = production_config()
        escaped["graphAuthentication"]["certificatePath"] = (
            "/etc/sandiva-hermes/credentials/../../../opt/sandiva/"
            "hermes-build-steward/credentials/hermes-graph.pfx"
        )
        with self.assertRaisesRegex(ConfigurationError, "absolute external Linux credential path"):
            RuntimeConfig.from_mapping(escaped)
        for required_field in ("tenantId", "clientId"):
            missing_identity = production_config()
            missing_identity["graphAuthentication"][required_field] = ""
            with self.assertRaisesRegex(ConfigurationError, required_field):
                RuntimeConfig.from_mapping(missing_identity)

    def test_ha08_untrusted_job_cannot_receive_or_mount_hostinger_certificate(self):
        config = RuntimeConfig.from_mapping(production_config())
        certificate_path = config.graph_authentication.certificate_path
        policy = IsolationPolicy(
            image="python:3.12-alpine@sha256:" + "a" * 64,
            cpu_limit="1.0", memory_limit="256m", pids_limit=64,
            tmpfs_size="128m", timeout_seconds=10, output_limit_bytes=2048,
        )
        command = build_docker_command(policy, "/var/tmp/hermes-job", ["python", "verify.py"])
        self.assertNotIn(certificate_path, " ".join(command))
        with self.assertRaisesRegex(ValueError, "not allowlisted"):
            sanitized_job_environment({}, {"HERMES_CERTIFICATE_PATH": certificate_path})
        module = qualification_module()
        probe = module.isolation_probe_script()
        self.assertIn(module.HOSTINGER_CERTIFICATE_SENTINEL_PATH, probe)
        completed = subprocess.run(
            [sys.executable, "-c", probe], check=True, capture_output=True, text=True,
        )
        observations = json.loads(completed.stdout)
        self.assertTrue(observations["certificateIsolation"])

    def test_ha09_token_failure_cannot_be_interpreted_as_missing_sharepoint_state(self):
        error_type = getattr(identity, "GraphTokenAcquisitionError", None)
        self.assertIsNotNone(error_type, "Graph token acquisition error type is missing")

        class NoGraphCalls:
            def request(self, *args, **kwargs):
                raise AssertionError("state transport must not run without a token")

        def failed_token():
            raise error_type("Graph token acquisition failed")

        with (
            patch("hermes_steward.cli._read_json", return_value=production_config()),
            patch("hermes_steward.cli.build_graph_token_provider", return_value=failed_token),
        ):
            with self.assertRaisesRegex(error_type, "Graph token acquisition failed"):
                _production_coordinator("synthetic-config.json")

        store = SharePointListStateStore(
            "https://graph.microsoft.com/v1.0/sites/site/lists/list",
            "prod.tasks", "hermes-prod-hostinger", failed_token, transport=NoGraphCalls(),
        )
        with self.assertRaisesRegex(error_type, "Graph token acquisition failed"):
            store.get("prod.tasks:HERMES-01:1")

    def test_ha10_existing_task_lease_fencing_and_recovery_behavior_is_unchanged(self):
        config = RuntimeConfig.from_mapping(production_config())
        coordinator = Coordinator(InMemoryStateStore(), config)
        task = build_task()
        coordinator.submit_task(task, SPEC_BYTES, AC_BYTES)
        lease = coordinator.claim(task["taskId"], task["taskVersion"], "hostinger-worker", 30)
        self.assertEqual(lease.fencing_token, 1)
        coordinator.begin_verification(task["taskId"], task["taskVersion"], lease.lease_id, lease.fencing_token)
        key = f"{config.task_namespace}:{task['taskId']}:{task['taskVersion']}"
        self.assertEqual(coordinator.store.get(key).value.status.value, "VERIFYING")


if __name__ == "__main__":
    unittest.main()
