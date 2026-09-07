"""Validate EXEC-01 synthetic Hostinger qualification evidence.

This entrypoint does not activate production or execute client material. An authorized
later qualification run supplies the trusted profile manifest and evidence produced by
the Hostinger coordinator, executor gateway, publisher and GitHub readback.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
from pathlib import Path

from hermes_steward.contracts import canonical_json, fingerprint
from hermes_steward.execution_contracts import ExecutorProfile


CONTRACT_SHA256 = "527dcd77c93ffc75482ca5633469d455d83f38351c6183e67d3ca2aee88ebad0"
REPOSITORY = "https://github.com/amengko-stack/sandiva"
BASE_SHA = "9ef9143479090bedc698b77fa7bf2cbc70b37b16"

REQUIRED_CHECKS = (
    "codexSyntheticDispatch",
    "claudeSyntheticDispatch",
    "providerCredentialIsolation",
    "controlPlaneCredentialIsolation",
    "networkContainment",
    "scopePathEnforcement",
    "timeoutTermination",
    "crashRecovery",
    "duplicateDispatch",
    "staleFenceDenial",
    "trustedPublisher",
    "normalizedBuildResult",
    "hermesIndependentVerification",
)


def _read(path: str) -> dict:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"{path} must contain one JSON object")
    return value


def load_profiles(path: str) -> dict[str, ExecutorProfile]:
    raw = _read(path)
    if set(raw) != {"codex", "claude-code"}:
        raise SystemExit("profile manifest must contain exactly codex and claude-code")
    profiles = {}
    for provider, value in raw.items():
        if not isinstance(value, dict):
            raise SystemExit(f"{provider} profile must be an object")
        profile = ExecutorProfile(**value)
        if profile.provider != provider:
            raise SystemExit(f"{provider} profile provider mismatch")
        profiles[provider] = profile
    return profiles


def qualification_plan(profiles: dict[str, ExecutorProfile]) -> dict:
    return {
        "buildId": "EXEC-01",
        "contractSha256": CONTRACT_SHA256,
        "classification": "synthetic-non-client",
        "profiles": {
            provider: {
                "profileId": item.profile_id,
                "profileFingerprint": item.fingerprint,
                "runtimeName": item.runtime_name,
                "runtimeVersion": item.runtime_version,
                "model": item.model,
                "launcherVersion": item.launcher_version,
            }
            for provider, item in sorted(profiles.items())
        },
        "requiredChecks": list(REQUIRED_CHECKS),
        "restrictions": {
            "draftPrOnly": True,
            "merge": False,
            "deployment": False,
            "productionActivation": False,
            "clientDocuments": False,
        },
    }


def sign_evidence(evidence: dict, attestation_key: bytes) -> dict:
    if "attestation" in evidence or len(attestation_key) < 32:
        raise ValueError("qualification evidence/key is invalid")
    value = json.loads(json.dumps(evidence))
    digest = hmac.new(attestation_key, canonical_json(value), hashlib.sha256).hexdigest()
    value["attestation"] = {"algorithm": "HMAC-SHA256", "digest": digest}
    return value


def _fail(message: str) -> None:
    raise SystemExit(message)


def verify_evidence(
    profiles: dict[str, ExecutorProfile], evidence: dict, *, attestation_key: bytes
) -> dict:
    if not isinstance(evidence, dict) or set(evidence) != {
        "buildId", "contractSha256", "classification", "repository", "baseSha", "headSha", "task",
        "profileFingerprints", "executionRecords", "pullRequestReadback", "containmentProbeEvidence",
        "checks", "hermesEvidence", "restrictions", "attestation",
    }:
        _fail("qualification evidence fields are invalid")
    attestation = evidence.get("attestation")
    unsigned = {key: value for key, value in evidence.items() if key != "attestation"}
    expected_signature = hmac.new(attestation_key, canonical_json(unsigned), hashlib.sha256).hexdigest()
    if (
        not isinstance(attestation, dict)
        or attestation.get("algorithm") != "HMAC-SHA256"
        or not hmac.compare_digest(str(attestation.get("digest", "")), expected_signature)
    ):
        _fail("qualification evidence attestation is invalid")
    if evidence.get("buildId") != "EXEC-01" or evidence.get("classification") != "synthetic-non-client":
        raise SystemExit("qualification evidence must be EXEC-01 synthetic-non-client")
    if evidence.get("contractSha256") != CONTRACT_SHA256:
        _fail("qualification contract identity mismatch")
    if evidence.get("repository") != REPOSITORY or evidence.get("baseSha") != BASE_SHA:
        _fail("qualification repository or immutable base mismatch")
    if not re.fullmatch(r"[0-9a-f]{40}", str(evidence.get("headSha", ""))):
        _fail("qualified implementation head is invalid")
    task = evidence.get("task")
    if (
        not isinstance(task, dict) or set(task) != {"id", "version", "fingerprint"}
        or not isinstance(task.get("id"), str) or not task["id"]
        or task.get("version") != 2 or not re.fullmatch(r"[0-9a-f]{64}", str(task.get("fingerprint", "")))
    ):
        _fail("qualification task identity is invalid")
    observed = evidence.get("profileFingerprints")
    expected = {provider: item.fingerprint for provider, item in profiles.items()}
    if observed != expected:
        raise SystemExit("qualification profile fingerprints do not match the approved manifest")
    checks = evidence.get("checks")
    if not isinstance(checks, dict) or set(checks) != set(REQUIRED_CHECKS):
        raise SystemExit("qualification evidence does not contain the exact required checks")
    if any(
        not isinstance(value, dict)
        or set(value) != {"origin", "evidenceFingerprint"}
        or value["origin"] not in {"trusted-runtime-probe", "trusted-github-readback", "trusted-hermes-independent"}
        or not re.fullmatch(r"[0-9a-f]{64}", str(value["evidenceFingerprint"]))
        for value in checks.values()
    ):
        _fail("qualification checks require trusted evidence identities, not booleans")

    records = evidence.get("executionRecords")
    if not isinstance(records, list) or len(records) != 2:
        _fail("qualification requires exactly two durable execution records")
    record_by_provider = {}
    seen_attempts = set()
    for record in records:
        if not isinstance(record, dict) or set(record) != {
            "task", "attemptId", "leaseId", "fencingToken", "profileFingerprint", "baseSha", "headSha",
            "branch", "commitSha", "draftPrNumber", "disposition", "recordFingerprint",
        }:
            _fail("durable execution record fields are invalid")
        provider = next((name for name, value in expected.items() if value == record["profileFingerprint"]), None)
        unsigned_record = {key: value for key, value in record.items() if key != "recordFingerprint"}
        if (
            provider is None or provider in record_by_provider or record["task"] != task
            or record["baseSha"] != BASE_SHA or record["headSha"] != evidence["headSha"]
            or record["disposition"] != "EXECUTION_SUCCEEDED"
            or not isinstance(record["attemptId"], str) or not record["attemptId"]
            or record["attemptId"] in seen_attempts
            or not isinstance(record["leaseId"], str) or not record["leaseId"]
            or not isinstance(record["fencingToken"], int) or isinstance(record["fencingToken"], bool) or record["fencingToken"] < 1
            or not re.fullmatch(r"build/[a-z0-9._/-]+", str(record["branch"]))
            or not re.fullmatch(r"[0-9a-f]{40}", str(record["commitSha"]))
            or not isinstance(record["draftPrNumber"], int) or record["draftPrNumber"] < 1
            or record["recordFingerprint"] != fingerprint(unsigned_record)
        ):
            _fail("durable execution record provenance is invalid or conflicting")
        seen_attempts.add(record["attemptId"])
        record_by_provider[provider] = record
    if set(record_by_provider) != set(profiles):
        _fail("qualification durable records do not cover both providers")

    pull_requests = evidence.get("pullRequestReadback")
    if not isinstance(pull_requests, list) or len(pull_requests) != 2:
        _fail("qualification requires exact trusted draft PR readback")
    seen_prs = set()
    for item in pull_requests:
        if not isinstance(item, dict) or set(item) != {
            "provider", "number", "head", "commitSha", "base", "isDraft", "merged", "checksReadbackFingerprint",
        }:
            _fail("trusted pull-request readback fields are invalid")
        record = record_by_provider.get(item["provider"])
        if (
            record is None or item["number"] in seen_prs or item["number"] != record["draftPrNumber"]
            or item["head"] != record["branch"] or item["commitSha"] != record["commitSha"]
            or item["base"] != "main" or item["isDraft"] is not True or item["merged"] is not False
            or not re.fullmatch(r"[0-9a-f]{64}", str(item["checksReadbackFingerprint"]))
        ):
            _fail("trusted pull-request readback conflicts with durable execution provenance")
        seen_prs.add(item["number"])

    probes = evidence.get("containmentProbeEvidence")
    if not isinstance(probes, list) or len(probes) != 2:
        _fail("qualification requires task-bound containment probe evidence")
    for probe in probes:
        record = record_by_provider.get(probe.get("provider")) if isinstance(probe, dict) else None
        if (
            not isinstance(probe, dict) or set(probe) != {
                "provider", "attemptId", "taskFingerprint", "profileFingerprint", "origin", "evidenceFingerprint",
            }
            or record is None or probe["attemptId"] != record["attemptId"]
            or probe["taskFingerprint"] != task["fingerprint"]
            or probe["profileFingerprint"] != record["profileFingerprint"]
            or probe["origin"] != "trusted-runtime-probe"
            or not re.fullmatch(r"[0-9a-f]{64}", str(probe["evidenceFingerprint"]))
        ):
            _fail("containment probe evidence is not bound to the qualified attempts")

    hermes = evidence.get("hermesEvidence")
    if (
        not isinstance(hermes, dict)
        or set(hermes) != {"origin", "evidenceIdentity", "taskFingerprint", "disposition"}
        or hermes["origin"] != "trusted-hermes-independent"
        or not isinstance(hermes["evidenceIdentity"], str) or not hermes["evidenceIdentity"].startswith("hermes://")
        or hermes["taskFingerprint"] != task["fingerprint"]
        or hermes["disposition"] not in {"PASS", "FAIL"}
    ):
        _fail("qualification requires independently sourced Hermes evidence")
    if evidence.get("restrictions") != {
        "draftPrOnly": True, "merged": False, "deployment": False,
        "productionActivation": False, "clientDocuments": False,
    }:
        _fail("qualification restrictions are invalid")
    return {
        "status": "QUALIFIED", "taskFingerprint": task["fingerprint"],
        "headSha": evidence["headSha"], "profiles": expected,
        "recordFingerprints": [record["recordFingerprint"] for record in records],
    }


def _read_attestation_key(path: str) -> bytes:
    key_path = Path(path)
    if os.name != "nt" and key_path.stat().st_mode & 0o077:
        _fail("qualification attestation key must not be group/world accessible")
    value = key_path.read_bytes()
    if len(value) < 32:
        _fail("qualification attestation key is invalid")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--evidence")
    parser.add_argument("--attestation-key-file")
    arguments = parser.parse_args()
    profiles = load_profiles(arguments.profiles)
    if arguments.evidence:
        if not arguments.attestation_key_file:
            _fail("evidence verification requires a trusted attestation key file")
        value = verify_evidence(
            profiles, _read(arguments.evidence),
            attestation_key=_read_attestation_key(arguments.attestation_key_file),
        )
    else:
        value = qualification_plan(profiles)
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
