from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping

from .evidence_producers import (
    ContainmentProbeProducer, HermesResultProducer, PfxOccurrenceSigner,
    ProducerAuthority, ProducerOccurrenceError, QualificationCheckProducer,
)
from .sharepoint_store import SharePointListStateStore


_ROLE_ENVIRONMENTS = {
    "containment-probe": ("EXEC01_PROBE_PFX_PASSWORD", "EXEC01_PROBE_STORE_TOKEN"),
    "qualification-check": ("EXEC01_CHECK_PFX_PASSWORD", "EXEC01_CHECK_STORE_TOKEN"),
    "hermes-result": ("EXEC01_HERMES_PFX_PASSWORD", "EXEC01_HERMES_STORE_TOKEN"),
}
_QUALIFICATION_CHECKS = {
    "codexSyntheticDispatch", "claudeSyntheticDispatch", "providerCredentialIsolation",
    "controlPlaneCredentialIsolation", "networkContainment", "scopePathEnforcement",
    "timeoutTermination", "crashRecovery", "duplicateDispatch", "staleFenceDenial",
    "trustedPublisher", "normalizedBuildResult", "hermesIndependentVerification",
}


def _closed(value: Any, fields: set[str], name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or set(value) != fields:
        raise ProducerOccurrenceError(f"{name} configuration is malformed")
    return value


def _read_json(path: Path) -> Mapping[str, Any]:
    raw = path.read_bytes()
    if len(raw) == 0 or len(raw) > 2 * 1024 * 1024:
        raise ProducerOccurrenceError("producer configuration size is invalid")
    value = json.loads(raw)
    if not isinstance(value, Mapping):
        raise ProducerOccurrenceError("producer configuration is malformed")
    return value


def _command_observer(raw: Any):
    command = _closed(raw, {"argv", "executableSha256", "timeoutSeconds", "outputLimitBytes"}, "observer")
    argv = command["argv"]
    if (
        not isinstance(argv, list) or not argv or any(not isinstance(item, str) or not item for item in argv)
        or not Path(argv[0]).is_absolute() or Path(argv[0]).is_symlink() or not Path(argv[0]).is_file()
        or hashlib.sha256(Path(argv[0]).read_bytes()).hexdigest() != command["executableSha256"]
        or not isinstance(command["timeoutSeconds"], int) or not 1 <= command["timeoutSeconds"] <= 60
        or not isinstance(command["outputLimitBytes"], int) or not 1024 <= command["outputLimitBytes"] <= 1024 * 1024
    ):
        raise ProducerOccurrenceError("producer observer is not an exact bounded executable")

    def invoke(payload: Mapping[str, Any]):
        completed = subprocess.run(
            argv, input=json.dumps(payload, sort_keys=True, separators=(",", ":")),
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=command["timeoutSeconds"], check=False,
            env={"PATH": "/opt/sandiva/bin:/usr/bin:/bin", "HOME": "/run/exec01-producer", "LANG": "C.UTF-8"},
        )
        if completed.returncode != 0 or len(completed.stdout.encode()) > command["outputLimitBytes"]:
            raise ProducerOccurrenceError("producer observer did not complete successfully")
        value = json.loads(completed.stdout)
        if not isinstance(value, (Mapping, list)):
            raise ProducerOccurrenceError("producer observer result is malformed")
        return value
    return invoke


def build_producer(config_path: Path):
    raw = _closed(
        _read_json(config_path),
        {"schemaVersion", "classification", "role", "authority", "pfxFile", "store", "observer"},
        "producer",
    )
    if raw["schemaVersion"] != "1.0" or raw["classification"] != "HOSTINGER_PRODUCTION":
        raise ProducerOccurrenceError("producer runtime is restricted to the production authority class")
    role = raw["role"]
    if role not in _ROLE_ENVIRONMENTS:
        raise ProducerOccurrenceError("producer role is not allowlisted")
    authority_raw = _closed(
        raw["authority"],
        {"origin", "producerIdentity", "storeIdentity", "verificationCertificateFile"},
        "producer authority",
    )
    base = config_path.parent
    certificate_path = (base / authority_raw["verificationCertificateFile"]).resolve()
    pfx_path = (base / raw["pfxFile"]).resolve()
    authority = ProducerAuthority(
        evidence_type=role, origin=authority_raw["origin"],
        producer_identity=authority_raw["producerIdentity"], store_identity=authority_raw["storeIdentity"],
        verification_certificate_pem=certificate_path.read_bytes(),
    )
    password_environment, token_environment = _ROLE_ENVIRONMENTS[role]
    password = os.environ.get(password_environment, "").encode()
    signer = PfxOccurrenceSigner(pfx_path, password, authority)
    store_raw = _closed(raw["store"], {"kind", "endpoint", "namespace", "environmentId", "tokenEnvironment"}, "producer store")
    if (
        store_raw["kind"] != "sharepoint" or store_raw["environmentId"] != "hostinger-production"
        or store_raw["tokenEnvironment"] != token_environment
        or not str(store_raw["namespace"]).startswith("prod.exec01.")
        or authority.store_identity != f"sharepoint:{store_raw['namespace']}"
    ):
        raise ProducerOccurrenceError("producer store is not bound to its exact production role")
    store = SharePointListStateStore(
        store_raw["endpoint"], store_raw["namespace"], store_raw["environmentId"],
        lambda: os.environ.get(token_environment, ""),
        record_encoder=lambda value: dict(value), record_decoder=lambda value: dict(value),
        status_getter=lambda value: "OCCURRENCE_PERSISTED",
    )
    if role == "containment-probe":
        return ContainmentProbeProducer(authority, signer, store, observer=_command_observer(raw["observer"]))
    if role == "qualification-check":
        observers = raw["observer"]
        if not isinstance(observers, Mapping) or set(observers) != _QUALIFICATION_CHECKS:
            raise ProducerOccurrenceError("qualification producer requires every exact independent check")
        return QualificationCheckProducer(
            authority, signer, store,
            checkers={name: _command_observer(value) for name, value in observers.items()},
        )
    origin_policy = os.environ.get("EXEC01_HERMES_ORIGIN_POLICY_FINGERPRINT", "")
    return HermesResultProducer(
        authority, signer, store, evaluator=_command_observer(raw["observer"]),
        origin_policy_fingerprint=origin_policy,
    )


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "--config":
        print("usage: exec01-evidence-producer --config CONFIG", file=sys.stderr)
        return 2
    try:
        producer = build_producer(Path(sys.argv[2]).resolve())
        request_raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(request_raw) == 0 or len(request_raw) > 2 * 1024 * 1024:
            raise ProducerOccurrenceError("producer occurrence request size is invalid")
        request = json.loads(request_raw)
        if not isinstance(request, Mapping):
            raise ProducerOccurrenceError("producer occurrence request is malformed")
        if isinstance(producer, ContainmentProbeProducer):
            value = producer.produce(request["context"], request["provider"], request["attemptId"], request["profileFingerprint"])
        elif isinstance(producer, QualificationCheckProducer):
            value = producer.produce(request["context"])
        else:
            value = producer.produce(
                request["context"], request["task"], request["criteria"],
                request["executionRecordFingerprints"], set(request["resolvableEvidenceReferences"]),
            )
        print(json.dumps(value, sort_keys=True, separators=(",", ":")))
        return 0
    except (KeyError, OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError, ProducerOccurrenceError) as error:
        print(f"evidence producer failed closed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
