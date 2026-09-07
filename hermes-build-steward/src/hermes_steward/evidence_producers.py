from __future__ import annotations

import base64
import datetime as dt
import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.serialization import pkcs12

from .contracts import canonical_json, fingerprint
from .store import RecordNotFound, StateStore, StoreConflict


class ProducerOccurrenceError(RuntimeError):
    pass


_ORIGINS = {
    "containment-probe": "trusted-runtime-probe",
    "qualification-check": "trusted-qualification-check",
    "hermes-result": "trusted-hermes-independent",
}


@dataclass(frozen=True)
class ProducerAuthority:
    evidence_type: str
    origin: str
    producer_identity: str
    store_identity: str
    verification_certificate_pem: bytes

    def __post_init__(self) -> None:
        try:
            certificate = x509.load_pem_x509_certificate(self.verification_certificate_pem)
        except (TypeError, ValueError) as error:
            raise ProducerOccurrenceError("producer verification certificate is invalid") from error
        if (
            self.evidence_type not in _ORIGINS
            or self.origin != _ORIGINS[self.evidence_type]
            or not self.producer_identity.startswith("sandiva-producer://hostinger/")
            or not self.store_identity.startswith("sharepoint:prod.")
            or not isinstance(certificate.public_key(), (rsa.RSAPublicKey, ec.EllipticCurvePublicKey))
        ):
            raise ProducerOccurrenceError("producer authority is not production-pinned")

    @property
    def certificate_fingerprint(self) -> str:
        certificate = x509.load_pem_x509_certificate(self.verification_certificate_pem)
        return certificate.fingerprint(hashes.SHA256()).hex()


class PfxOccurrenceSigner:
    """Occurrence-time signer. The collector receives only ProducerAuthority."""

    def __init__(self, pfx_path: Path, password: bytes, authority: ProducerAuthority):
        if (
            pfx_path.is_symlink() or not pfx_path.is_file() or len(password) < 12
            or (os.name != "nt" and pfx_path.stat().st_mode & 0o077)
        ):
            raise ProducerOccurrenceError("producer PFX credential is unavailable or unsafe")
        try:
            key, certificate, _ = pkcs12.load_key_and_certificates(pfx_path.read_bytes(), password)
        except (OSError, TypeError, ValueError) as error:
            raise ProducerOccurrenceError("producer PFX credential is invalid") from error
        if key is None or certificate is None:
            raise ProducerOccurrenceError("producer PFX credential lacks a signing identity")
        observed = certificate.public_bytes(serialization.Encoding.PEM)
        if x509.load_pem_x509_certificate(observed).fingerprint(hashes.SHA256()).hex() != authority.certificate_fingerprint:
            raise ProducerOccurrenceError("producer PFX does not match its pinned public authority")
        self._key = key
        self.authority = authority

    def sign(self, value: Mapping[str, Any], *, clock: Callable[[], dt.datetime] | None = None) -> dict[str, Any]:
        unsigned = dict(value)
        if "producerAttestation" in unsigned:
            raise ProducerOccurrenceError("producer occurrence is already attested")
        if (
            unsigned.get("origin") != self.authority.origin
            or unsigned.get("producerIdentity") != self.authority.producer_identity
            or unsigned.get("authoritativeStoreIdentity") != self.authority.store_identity
            or not isinstance(unsigned.get("evidenceContext"), Mapping)
            or unsigned["evidenceContext"].get("evidenceType") != self.authority.evidence_type
        ):
            raise ProducerOccurrenceError("producer cannot sign another role or authority")
        now = (clock or (lambda: dt.datetime.now(dt.timezone.utc)))()
        if now.tzinfo is None:
            raise ProducerOccurrenceError("producer occurrence time must include a timezone")
        occurred_at = now.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        occurrence_id = fingerprint({
            "evidenceType": self.authority.evidence_type,
            "sourceIdentity": unsigned.get("sourceIdentity", unsigned.get("evidenceIdentity")),
            "evidenceFingerprint": unsigned.get("evidenceFingerprint", unsigned.get("resultFingerprint")),
            "occurredAt": occurred_at,
        })
        signed_payload = canonical_json({
            "record": unsigned, "occurrenceId": occurrence_id, "occurredAt": occurred_at,
        })
        if isinstance(self._key, rsa.RSAPrivateKey):
            algorithm = "RSA-PSS-SHA256"
            signature = self._key.sign(
                signed_payload,
                padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
                hashes.SHA256(),
            )
        elif isinstance(self._key, ec.EllipticCurvePrivateKey):
            algorithm = "ECDSA-SHA256"
            signature = self._key.sign(signed_payload, ec.ECDSA(hashes.SHA256()))
        else:
            raise ProducerOccurrenceError("producer signing key type is unsupported")
        return {
            **unsigned,
            "producerAttestation": {
                "algorithm": algorithm,
                "certificateFingerprint": self.authority.certificate_fingerprint,
                "occurrenceId": occurrence_id,
                "occurredAt": occurred_at,
                "signature": base64.b64encode(signature).decode("ascii"),
            },
        }


def verify_occurrence_record(raw: Mapping[str, Any], authority: ProducerAuthority) -> dict[str, Any]:
    value = dict(raw)
    attestation = value.pop("producerAttestation", None)
    source_identity = value.get("sourceIdentity", value.get("evidenceIdentity"))
    evidence_fingerprint = value.get("evidenceFingerprint", value.get("resultFingerprint"))
    if (
        value.get("origin") != authority.origin
        or value.get("producerIdentity") != authority.producer_identity
        or value.get("authoritativeStoreIdentity") != authority.store_identity
        or not isinstance(value.get("evidenceContext"), Mapping)
        or value["evidenceContext"].get("evidenceType") != authority.evidence_type
        or not isinstance(source_identity, str) or not source_identity
        or not isinstance(attestation, Mapping)
        or set(attestation) != {"algorithm", "certificateFingerprint", "occurrenceId", "occurredAt", "signature"}
        or attestation.get("certificateFingerprint") != authority.certificate_fingerprint
        or not re.fullmatch(r"[0-9a-f]{64}", str(attestation.get("occurrenceId", "")))
        or not isinstance(attestation.get("occurredAt"), str)
    ):
        raise ProducerOccurrenceError("producer occurrence authority is invalid")
    expected_occurrence = fingerprint({
        "evidenceType": authority.evidence_type,
        "sourceIdentity": source_identity,
        "evidenceFingerprint": evidence_fingerprint,
        "occurredAt": attestation["occurredAt"],
    })
    if attestation["occurrenceId"] != expected_occurrence:
        raise ProducerOccurrenceError("producer occurrence identity is invalid")
    try:
        signature = base64.b64decode(attestation["signature"], validate=True)
    except (TypeError, ValueError) as error:
        raise ProducerOccurrenceError("producer occurrence signature is malformed") from error
    payload = canonical_json({
        "record": value, "occurrenceId": attestation["occurrenceId"],
        "occurredAt": attestation["occurredAt"],
    })
    public_key = x509.load_pem_x509_certificate(authority.verification_certificate_pem).public_key()
    try:
        if attestation["algorithm"] == "RSA-PSS-SHA256" and isinstance(public_key, rsa.RSAPublicKey):
            public_key.verify(
                signature, payload,
                padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
                hashes.SHA256(),
            )
        elif attestation["algorithm"] == "ECDSA-SHA256" and isinstance(public_key, ec.EllipticCurvePublicKey):
            public_key.verify(signature, payload, ec.ECDSA(hashes.SHA256()))
        else:
            raise ProducerOccurrenceError("producer occurrence algorithm does not match its certificate")
    except InvalidSignature as error:
        raise ProducerOccurrenceError("producer occurrence signature is invalid") from error
    value["producerAttestation"] = dict(attestation)
    return value


class ContainmentObserver(Protocol):
    def __call__(self, request: Mapping[str, Any]) -> Mapping[str, bool]: ...


class _ProducerBase:
    def __init__(self, authority: ProducerAuthority, signer: PfxOccurrenceSigner, store: StateStore[Mapping[str, Any]]):
        if signer.authority != authority:
            raise ProducerOccurrenceError("producer signer and public authority differ")
        self.authority = authority
        self.signer = signer
        self.store = store

    def _persist_once(self, key: str, build: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        try:
            existing = self.store.get(key).value
        except RecordNotFound:
            existing = None
        if existing is not None:
            return verify_occurrence_record(existing, self.authority)
        signed = self.signer.sign(build())
        try:
            return dict(self.store.create(key, signed).value)
        except StoreConflict:
            return verify_occurrence_record(self.store.get(key).value, self.authority)


class ContainmentProbeProducer(_ProducerBase):
    REQUIRED = {
        "providerCredentialReadable": False, "publisherCredentialReadable": False,
        "hermesCredentialReadable": False, "coordinatorSecretsReadable": False,
        "networkPolicyEnforced": True, "resourcePolicyEnforced": True,
        "workspaceBoundaryEnforced": True,
    }

    def __init__(self, authority: ProducerAuthority, signer: PfxOccurrenceSigner,
                 store: StateStore[Mapping[str, Any]], *, observer: ContainmentObserver):
        super().__init__(authority, signer, store)
        if authority.evidence_type != "containment-probe":
            raise ProducerOccurrenceError("containment producer has the wrong role")
        self.observer = observer

    def produce(self, context: Mapping[str, Any], provider: str, attempt_id: str,
                profile_fingerprint: str) -> dict[str, Any]:
        if (
            context.get("evidenceType") != "containment-probe"
            or provider not in {"codex", "claude-code"}
            or attempt_id not in context.get("attemptIds", [])
            or profile_fingerprint not in context.get("profileFingerprints", [])
        ):
            raise ProducerOccurrenceError("containment occurrence identity is invalid")
        source = f"runtime-probe://{context['runId']}/{context['headSha']}/{attempt_id}/containment"
        key = fingerprint({"source": source, "producer": self.authority.producer_identity})
        def build() -> dict[str, Any]:
            observations = dict(self.observer({
                "context": dict(context), "provider": provider,
                "attemptId": attempt_id, "profileFingerprint": profile_fingerprint,
            }))
            if observations != self.REQUIRED:
                raise ProducerOccurrenceError("containment observation did not establish the required controls")
            value = {
                "provider": provider, "attemptId": attempt_id,
                "taskFingerprint": context["taskFingerprint"],
                "profileFingerprint": profile_fingerprint,
                "origin": self.authority.origin, "sourceIdentity": source,
                "observations": observations,
                "producerIdentity": self.authority.producer_identity,
                "authoritativeStoreIdentity": self.authority.store_identity,
                "evidenceContext": dict(context),
            }
            value["evidenceFingerprint"] = fingerprint(value)
            return value
        return self._persist_once(key, build)


class QualificationCheckProducer(_ProducerBase):
    def __init__(self, authority: ProducerAuthority, signer: PfxOccurrenceSigner,
                 store: StateStore[Mapping[str, Any]], *,
                 checkers: Mapping[str, Callable[[Mapping[str, Any]], list[str]]]):
        super().__init__(authority, signer, store)
        if authority.evidence_type != "qualification-check" or not checkers:
            raise ProducerOccurrenceError("qualification-check producer has the wrong or empty authority")
        self.checkers = dict(checkers)

    def produce(self, context: Mapping[str, Any]) -> list[dict[str, Any]]:
        if context.get("evidenceType") != "qualification-check":
            raise ProducerOccurrenceError("qualification-check occurrence context is invalid")
        records = []
        for name, checker in sorted(self.checkers.items()):
            source = f"qualification-check://{context['runId']}/{context['headSha']}/{name}"
            key = fingerprint({"source": source, "producer": self.authority.producer_identity})
            def build(name=name, checker=checker, source=source) -> dict[str, Any]:
                support = checker(dict(context))
                if not support or any(not re.fullmatch(r"[0-9a-f]{64}", item) for item in support):
                    raise ProducerOccurrenceError("qualification check did not resolve authoritative support")
                value = {
                    "taskFingerprint": context["taskFingerprint"], "name": name,
                    "origin": self.authority.origin, "sourceIdentity": source,
                    "producerIdentity": self.authority.producer_identity,
                    "authoritativeStoreIdentity": self.authority.store_identity,
                    "evidenceContext": dict(context),
                    "supportingEvidenceFingerprints": list(support),
                }
                value["evidenceFingerprint"] = fingerprint(value)
                return value
            records.append(self._persist_once(key, build))
        return records


class HermesResultProducer(_ProducerBase):
    def __init__(self, authority: ProducerAuthority, signer: PfxOccurrenceSigner,
                 store: StateStore[Mapping[str, Any]], *,
                 evaluator: Callable[[Mapping[str, Any]], list[dict[str, Any]]],
                 origin_policy_fingerprint: str):
        super().__init__(authority, signer, store)
        if authority.evidence_type != "hermes-result" or not re.fullmatch(r"[0-9a-f]{64}", origin_policy_fingerprint):
            raise ProducerOccurrenceError("Hermes producer authority is invalid")
        self.evaluator = evaluator
        self.origin_policy_fingerprint = origin_policy_fingerprint

    def produce(self, context: Mapping[str, Any], task: Mapping[str, Any], criteria: list[str],
                execution_record_fingerprints: list[str], resolvable_references: set[str]) -> dict[str, Any]:
        if context.get("evidenceType") != "hermes-result":
            raise ProducerOccurrenceError("Hermes occurrence context is invalid")
        source = f"hermes://{context['runId']}/{context['headSha']}/final"
        key = fingerprint({"source": source, "producer": self.authority.producer_identity})
        def build() -> dict[str, Any]:
            results = self.evaluator({
                "context": dict(context), "task": dict(task), "criteria": list(criteria),
                "executionRecordFingerprints": list(execution_record_fingerprints),
                "resolvableEvidenceReferences": sorted(resolvable_references),
            })
            if (
                [item.get("criterion") for item in results] != criteria
                or any(item.get("disposition") != "PASS" for item in results)
                or any(ref not in resolvable_references for item in results for ref in item.get("evidenceReferences", []))
            ):
                raise ProducerOccurrenceError("independent Hermes evaluation is incomplete or non-PASS")
            value = {
                "schemaVersion": "1.0", "origin": self.authority.origin,
                "evidenceIdentity": source,
                "task": dict(task), "criteriaResults": results,
                "executionRecordFingerprints": list(execution_record_fingerprints),
                "originPolicyFingerprint": self.origin_policy_fingerprint,
                "disposition": "PASS", "producerIdentity": self.authority.producer_identity,
                "authoritativeStoreIdentity": self.authority.store_identity,
                "evidenceContext": dict(context),
            }
            value["resultFingerprint"] = fingerprint(value)
            return value
        return self._persist_once(key, build)
