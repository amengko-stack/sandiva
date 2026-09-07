from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

from hermes_steward.evidence_producers import (
    ContainmentProbeProducer,
    HermesResultProducer,
    PfxOccurrenceSigner,
    ProducerAuthority,
    ProducerOccurrenceError,
    QualificationCheckProducer,
    verify_occurrence_record,
)
from hermes_steward.contracts import fingerprint
from hermes_steward.store import InMemoryStateStore
from qualification.run_exec01_vm_qualification import REQUIRED_CHECKS, TrustedEvidenceProducer, _validate_producer_record
from test_exec01_third_rework import authoritative_collector_fixture


def pfx_identity(root: Path, name: str, evidence_type: str, store_identity: str):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1))
        .not_valid_after(dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    password = b"synthetic-pfx-password"
    pfx_path = root / f"{name}.pfx"
    pfx_path.write_bytes(pkcs12.serialize_key_and_certificates(
        name.encode(), key, certificate, None,
        serialization.BestAvailableEncryption(password),
    ))
    certificate_pem = certificate.public_bytes(serialization.Encoding.PEM)
    authority = ProducerAuthority(
        evidence_type=evidence_type,
        origin={
            "containment-probe": "trusted-runtime-probe",
            "qualification-check": "trusted-qualification-check",
            "hermes-result": "trusted-hermes-independent",
        }[evidence_type],
        producer_identity=f"sandiva-producer://hostinger/{name}/v1",
        store_identity=store_identity,
        verification_certificate_pem=certificate_pem,
    )
    signer = PfxOccurrenceSigner(pfx_path, password, authority)
    return authority, signer


class SeventhReworkTrustedProducerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.context = {
            "runId": "seventh-run",
            "headSha": "7" * 40,
            "taskFingerprint": "a" * 64,
            "attemptIds": ["attempt-codex"],
            "profileFingerprints": ["b" * 64],
        }

    def tearDown(self):
        self.temporary.cleanup()

    def test_actual_role_separated_pfx_producers_observe_sign_and_persist_occurrences(self):
        probe_store, check_store, hermes_store = InMemoryStateStore(), InMemoryStateStore(), InMemoryStateStore()
        probe_authority, probe_signer = pfx_identity(self.root, "runtime-probe", "containment-probe", "sharepoint:prod.exec01.probes")
        check_authority, check_signer = pfx_identity(self.root, "qualification-check", "qualification-check", "sharepoint:prod.exec01.checks")
        hermes_authority, hermes_signer = pfx_identity(self.root, "hermes-independent", "hermes-result", "sharepoint:prod.exec01.hermes")

        observations = {
            "providerCredentialReadable": False, "publisherCredentialReadable": False,
            "hermesCredentialReadable": False, "coordinatorSecretsReadable": False,
            "networkPolicyEnforced": True, "resourcePolicyEnforced": True,
            "workspaceBoundaryEnforced": True,
        }
        probe = ContainmentProbeProducer(
            probe_authority, probe_signer, probe_store,
            observer=lambda request: observations,
        ).produce({**self.context, "evidenceType": "containment-probe"}, "codex", "attempt-codex", "b" * 64)
        self.assertEqual(len(probe_store.list_records()), 1)
        verify_occurrence_record(probe, probe_authority)

        check = QualificationCheckProducer(
            check_authority, check_signer, check_store,
            checkers={"scopePathEnforcement": lambda request: [probe["evidenceFingerprint"]]},
        ).produce({**self.context, "evidenceType": "qualification-check"})
        self.assertEqual(len(check_store.list_records()), 1)
        verify_occurrence_record(check[0], check_authority)

        hermes = HermesResultProducer(
            hermes_authority, hermes_signer, hermes_store,
            evaluator=lambda request: [{
                "criterion": "AC-04", "disposition": "PASS",
                "evidenceReferences": [check[0]["sourceIdentity"]],
            }],
            origin_policy_fingerprint="c" * 64,
        ).produce(
            {**self.context, "evidenceType": "hermes-result"},
            {"id": "EXEC-01", "version": "2.0", "fingerprint": "a" * 64},
            ["AC-04"], ["d" * 64], {check[0]["sourceIdentity"]},
        )
        self.assertEqual(len(hermes_store.list_records()), 1)
        verify_occurrence_record(hermes, hermes_authority)

        with self.assertRaises(ProducerOccurrenceError):
            verify_occurrence_record(probe, check_authority)
        with self.assertRaises(ProducerOccurrenceError):
            verify_occurrence_record(check[0], hermes_authority)

    def test_producer_crash_writes_nothing_and_restart_is_idempotent_without_duplicate_occurrence(self):
        store = InMemoryStateStore()
        authority, signer = pfx_identity(self.root, "runtime-probe", "containment-probe", "sharepoint:prod.exec01.probes")
        def crash(_):
            raise RuntimeError("probe crashed")
        with self.assertRaisesRegex(RuntimeError, "probe crashed"):
            ContainmentProbeProducer(authority, signer, store, observer=crash).produce(
                {**self.context, "evidenceType": "containment-probe"}, "codex", "attempt-codex", "b" * 64,
            )
        self.assertEqual(store.list_records(), [])

        observations = {
            "providerCredentialReadable": False, "publisherCredentialReadable": False,
            "hermesCredentialReadable": False, "coordinatorSecretsReadable": False,
            "networkPolicyEnforced": True, "resourcePolicyEnforced": True,
            "workspaceBoundaryEnforced": True,
        }
        producer = ContainmentProbeProducer(authority, signer, store, observer=lambda request: observations)
        first = producer.produce({**self.context, "evidenceType": "containment-probe"}, "codex", "attempt-codex", "b" * 64)
        second = producer.produce({**self.context, "evidenceType": "containment-probe"}, "codex", "attempt-codex", "b" * 64)
        self.assertEqual(first, second)
        self.assertEqual(len(store.list_records()), 1)

    def test_structurally_plausible_record_from_wrong_private_producer_is_rejected(self):
        correct, _ = pfx_identity(self.root, "runtime-probe", "containment-probe", "sharepoint:prod.exec01.probes")
        wrong, wrong_signer = pfx_identity(self.root, "executor-forgery", "containment-probe", "sharepoint:prod.exec01.probes")
        unsigned = {
            "schemaVersion": "1.0", "origin": wrong.origin,
            "producerIdentity": wrong.producer_identity,
            "authoritativeStoreIdentity": wrong.store_identity,
            "sourceIdentity": "runtime-probe://seventh-run/attempt-codex/containment",
            "evidenceContext": {**self.context, "evidenceType": "containment-probe"},
            "producerOccurrenceId": "occurrence-forged",
            "observedAt": "2026-09-07T00:00:00Z",
            "evidenceFingerprint": "0" * 64,
        }
        forged = wrong_signer.sign(unsigned)
        forged["producerIdentity"] = correct.producer_identity
        with self.assertRaises(ProducerOccurrenceError):
            verify_occurrence_record(forged, correct)

    def test_production_collector_authority_has_public_certificate_only_and_verifies_occurrence(self):
        authority, signer = pfx_identity(
            self.root, "runtime-probe", "containment-probe", "sharepoint:prod.exec01.probes",
        )
        context = {**self.context, "evidenceType": "containment-probe"}
        value = {
            "provider": "codex", "attemptId": "attempt-codex",
            "taskFingerprint": "a" * 64, "profileFingerprint": "b" * 64,
            "origin": authority.origin,
            "sourceIdentity": "runtime-probe://seventh-run/" + "7" * 40 + "/attempt-codex/containment",
            "observations": ContainmentProbeProducer.REQUIRED,
            "producerIdentity": authority.producer_identity,
            "authoritativeStoreIdentity": authority.store_identity,
            "evidenceContext": context,
        }
        value["evidenceFingerprint"] = fingerprint(value)
        signed = signer.sign(value)
        collector_authority = TrustedEvidenceProducer.from_public_certificate(authority)
        self.assertIsNone(collector_authority.authentication_key)
        observed = _validate_producer_record(
            signed, collector_authority, context=context, source_identity=value["sourceIdentity"],
        )
        self.assertEqual(observed, signed)

    def test_pfx01_pfx09_collector_reads_actual_separate_occurrences_and_cannot_manufacture_them(self):
        collector, _ = authoritative_collector_fixture()
        authorities = {}
        signers = {}
        identities = {
            "containment-probe": "sharepoint:prod.exec01.probes",
            "qualification-check": "sharepoint:prod.exec01.checks",
            "hermes-result": "sharepoint:prod.exec01.hermes",
        }
        for evidence_type, store_identity in identities.items():
            authorities[evidence_type], signers[evidence_type] = pfx_identity(
                self.root, f"seventh-{evidence_type}", evidence_type, store_identity,
            )
        def convert(store, evidence_type):
            converted = InMemoryStateStore()
            for index, versioned in enumerate(store.list_records()):
                value = dict(versioned.value)
                value.pop("producerAuthentication", None)
                value.pop("producerAttestation", None)
                value["producerIdentity"] = authorities[evidence_type].producer_identity
                value["authoritativeStoreIdentity"] = authorities[evidence_type].store_identity
                fingerprint_field = "resultFingerprint" if evidence_type == "hermes-result" else "evidenceFingerprint"
                value.pop(fingerprint_field, None)
                value[fingerprint_field] = fingerprint(value)
                converted.create(f"occurrence-{index}", signers[evidence_type].sign(value))
            return converted
        collector.probe_store = convert(collector.probe_store, "containment-probe")
        collector.check_store = convert(collector.check_store, "qualification-check")
        collector.hermes_evidence_store = convert(collector.hermes_evidence_store, "hermes-result")
        collector.evidence_producers = {
            evidence_type: TrustedEvidenceProducer.from_public_certificate(authority)
            for evidence_type, authority in authorities.items()
        }
        resolved = collector.resolve()
        self.assertEqual(len(resolved["containmentProbeEvidence"]), 2)
        self.assertEqual(len(resolved["checks"]), len(REQUIRED_CHECKS))
        self.assertEqual(resolved["hermesEvidence"]["disposition"], "PASS")

        for missing in ("probe_store", "check_store", "hermes_evidence_store"):
            original = getattr(collector, missing)
            setattr(collector, missing, InMemoryStateStore())
            with self.subTest(missing=missing), self.assertRaises(SystemExit):
                collector.resolve()
            setattr(collector, missing, original)

    def test_pfx10_role_private_keys_do_not_cross_authority_and_executor_staging_is_rejected(self):
        probe_authority, probe_signer = pfx_identity(self.root, "probe-role", "containment-probe", "sharepoint:prod.exec01.probes")
        check_authority, check_signer = pfx_identity(self.root, "check-role", "qualification-check", "sharepoint:prod.exec01.checks")
        hermes_authority, _ = pfx_identity(self.root, "hermes-role", "hermes-result", "sharepoint:prod.exec01.hermes")
        unsigned = {
            "origin": probe_authority.origin, "producerIdentity": probe_authority.producer_identity,
            "authoritativeStoreIdentity": probe_authority.store_identity,
            "sourceIdentity": "runtime-probe://run/head/attempt/containment",
            "evidenceContext": {**self.context, "evidenceType": "containment-probe"},
            "evidenceFingerprint": "1" * 64,
        }
        with self.assertRaises(ProducerOccurrenceError):
            check_signer.sign(unsigned)
        signed_probe = probe_signer.sign(unsigned)
        with self.assertRaises(ProducerOccurrenceError):
            verify_occurrence_record(signed_probe, check_authority)
        with self.assertRaises(ProducerOccurrenceError):
            verify_occurrence_record(signed_probe, hermes_authority)
        staged = dict(unsigned)
        staged["producerAttestation"] = {
            "algorithm": "RSA-PSS-SHA256", "certificateFingerprint": probe_authority.certificate_fingerprint,
            "occurrenceId": "2" * 64, "occurredAt": "2026-09-07T00:00:00Z", "signature": "c3RhZ2Vk",
        }
        with self.assertRaises(ProducerOccurrenceError):
            verify_occurrence_record(staged, probe_authority)
