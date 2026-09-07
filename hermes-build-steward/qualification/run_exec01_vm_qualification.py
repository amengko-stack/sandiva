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
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import quote

from hermes_steward.contracts import canonical_json, fingerprint
from hermes_steward.contracts import validate_dispatch_build_task
from hermes_steward.execution_contracts import ExecutorProfile
from hermes_steward.execution_publisher import GitHubTransport
from hermes_steward.store import StateStore


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


class TrustedQualificationResolver(Protocol):
    def resolve(self) -> Mapping[str, Any]: ...


class TrustedGitHubQualificationReadPath:
    """Acquire branch, PR and check evidence through a repository-scoped trusted transport."""

    def __init__(self, repository: str, transport: GitHubTransport):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("qualification GitHub repository identity is invalid")
        self.repository = repository
        self.transport = transport

    def read(self, provider: str, record: Mapping[str, Any]) -> dict[str, Any]:
        branch = record["branch"]
        commit_sha = record["commitSha"]
        status, value = self.transport.request("GET", f"/git/ref/heads/{quote(str(branch), safe='')}")
        observed_sha = (
            value.get("object", {}).get("sha")
            if status == 200 and isinstance(value, Mapping) and isinstance(value.get("object"), Mapping)
            else None
        )
        if observed_sha != commit_sha:
            _fail("trusted GitHub branch readback conflicts with the durable commit")
        owner = self.repository.split("/", 1)[0]
        status, values = self.transport.request(
            "GET", f"/pulls?state=all&head={quote(owner + ':' + str(branch), safe=':')}"
        )
        matches = [
            item for item in values
            if isinstance(item, Mapping) and item.get("number") == record["draftPrNumber"]
        ] if status == 200 and isinstance(values, list) else []
        if len(matches) != 1:
            _fail("trusted GitHub qualification readback requires exactly one task PR")
        pull_request = matches[0]
        head, base = pull_request.get("head"), pull_request.get("base")
        if not isinstance(head, Mapping) or not isinstance(base, Mapping):
            _fail("trusted GitHub pull-request readback is malformed")
        status, value = self.transport.request("GET", f"/commits/{commit_sha}/check-runs")
        check_runs = value.get("check_runs") if status == 200 and isinstance(value, Mapping) else None
        if (
            not isinstance(check_runs, list) or not check_runs
            or any(
                not isinstance(item, Mapping) or item.get("head_sha") != commit_sha
                or item.get("conclusion") != "success"
                for item in check_runs
            )
        ):
            _fail("trusted GitHub check readback is missing, unbound, or unsuccessful")
        normalized_checks = sorted(
            ({"id": item.get("id"), "name": item.get("name"), "headSha": item.get("head_sha"),
              "conclusion": item.get("conclusion")} for item in check_runs),
            key=lambda item: (str(item["id"]), str(item["name"])),
        )
        return {
            "provider": provider, "number": pull_request.get("number"), "head": head.get("ref"),
            "commitSha": observed_sha, "base": base.get("ref"), "state": pull_request.get("state"),
            "isDraft": pull_request.get("draft"),
            "merged": pull_request.get("merged", pull_request.get("merged_at") is not None),
            "checksReadbackFingerprint": fingerprint(normalized_checks),
        }


class DurableQualificationEvidenceCollector:
    """Resolve qualification facts from durable authorities before signing."""

    def __init__(
        self, *, task_store: StateStore[Any], task_key: str,
        result_store: StateStore[Mapping[str, Any]], probe_store: StateStore[Mapping[str, Any]],
        check_store: StateStore[Mapping[str, Any]],
        hermes_evidence_store: StateStore[Mapping[str, Any]],
        github_reader: TrustedGitHubQualificationReadPath,
        implementation_head_loader: Callable[[], str],
    ):
        self.task_store = task_store
        self.task_key = task_key
        self.result_store = result_store
        self.probe_store = probe_store
        self.check_store = check_store
        self.hermes_evidence_store = hermes_evidence_store
        self.github_reader = github_reader
        self.implementation_head_loader = implementation_head_loader

    @staticmethod
    def _values(store: StateStore[Mapping[str, Any]]) -> list[dict[str, Any]]:
        values = []
        for item in store.list_records():
            if not isinstance(item.value, Mapping):
                _fail("qualification durable store contains a malformed record")
            values.append(dict(item.value))
        return values

    def resolve(self) -> Mapping[str, Any]:
        value = self.task_store.get(self.task_key).value
        raw_task = getattr(value, "task", value)
        if not isinstance(raw_task, Mapping):
            _fail("qualification task authority record is malformed")
        task = validate_dispatch_build_task(raw_task)
        task_fingerprint = fingerprint(task)
        task_identity = {"id": task["taskId"], "version": task["taskVersion"], "fingerprint": task_fingerprint}
        durable_values = self._values(self.result_store)
        results = {
            (item.get("taskFingerprint"), item.get("attemptId")): item
            for item in durable_values if item.get("schemaVersion") == "1.0" and "disposition" in item
        }
        audits = [
            item for item in durable_values
            if item.get("schemaVersion") == "1.0" and isinstance(item.get("task"), Mapping)
            and item["task"].get("fingerprint") == task_fingerprint
            and isinstance(item.get("attempt"), Mapping)
            and isinstance(item.get("publication"), Mapping)
            and isinstance(item.get("executor"), Mapping)
        ]
        head_sha = self.implementation_head_loader()
        records, pull_requests = [], []
        for audit in audits:
            attempt, publication, executor = audit["attempt"], audit["publication"], audit["executor"]
            result = results.get((task_fingerprint, attempt.get("attemptId")))
            draft_pr, repository = publication.get("draftPr"), audit.get("repository")
            audit_result = audit.get("result")
            if (
                result is None or not isinstance(draft_pr, Mapping) or not isinstance(repository, Mapping)
                or not isinstance(audit_result, Mapping) or repository.get("url") != task["repository"]
                or repository.get("baseSha") != task["baseRef"]
                or result.get("disposition") != audit_result.get("disposition")
                or result.get("taskId") != task["taskId"] or result.get("taskVersion") != task["taskVersion"]
                or result.get("baseSha") != task["baseRef"]
                or result.get("auditProvenanceId") != audit.get("auditProvenanceId")
                or not isinstance(result.get("executorProfile"), Mapping)
                or result["executorProfile"].get("profileFingerprint") != executor.get("profileFingerprint")
                or result.get("branch") != publication.get("branch")
                or result.get("commitSha") != publication.get("commitSha")
                or not isinstance(result.get("draftPr"), Mapping)
                or result["draftPr"].get("number") != draft_pr.get("number")
            ):
                _fail("durable result and audit provenance do not agree")
            record = {
                "task": task_identity, "attemptId": attempt.get("attemptId"),
                "leaseId": attempt.get("leaseId"), "fencingToken": attempt.get("fencingToken"),
                "profileFingerprint": executor.get("profileFingerprint"), "baseSha": task["baseRef"],
                "headSha": head_sha, "branch": publication.get("branch"),
                "commitSha": publication.get("commitSha"), "draftPrNumber": draft_pr.get("number"),
                "disposition": result.get("disposition"),
            }
            record["recordFingerprint"] = fingerprint(record)
            records.append(record)
            provider = executor.get("provider")
            if not isinstance(provider, str):
                _fail("durable executor provider provenance is missing")
            pull_requests.append(self.github_reader.read(provider, record))

        probes = [item for item in self._values(self.probe_store) if item.get("taskFingerprint") == task_fingerprint]
        hermes_values = [
            item for item in self._values(self.hermes_evidence_store)
            if item.get("taskFingerprint") == task_fingerprint
        ]
        if len(hermes_values) != 1:
            _fail("qualification requires exactly one independently acquired Hermes disposition")
        checks: dict[str, Any] = {}
        for item in self._values(self.check_store):
            if item.get("taskFingerprint") != task_fingerprint:
                continue
            if set(item) != {"taskFingerprint", "name", "origin", "evidenceFingerprint"}:
                _fail("qualification check authority record is malformed")
            if item["name"] in checks:
                _fail("qualification check authority contains duplicates")
            checks[str(item["name"])] = {
                "origin": item["origin"], "evidenceFingerprint": item["evidenceFingerprint"]
            }
        return {
            "buildId": "EXEC-01", "contractSha256": CONTRACT_SHA256,
            "classification": "synthetic-non-client", "repository": task["repository"],
            "baseSha": task["baseRef"], "headSha": head_sha, "task": task_identity,
            "profileFingerprints": {}, "executionRecords": records,
            "pullRequestReadback": pull_requests, "containmentProbeEvidence": probes,
            "checks": checks, "hermesEvidence": hermes_values[0],
            "restrictions": {"draftPrOnly": True, "merged": False, "deployment": False,
                             "productionActivation": False, "clientDocuments": False},
        }

    def collect_and_sign(self, profiles: Mapping[str, ExecutorProfile], attestation_key: bytes) -> dict:
        value = dict(self.resolve())
        value["profileFingerprints"] = {provider: item.fingerprint for provider, item in profiles.items()}
        return sign_evidence(value, attestation_key)


def _fail(message: str) -> None:
    raise SystemExit(message)


def verify_evidence(
    profiles: dict[str, ExecutorProfile], evidence: dict, *, attestation_key: bytes,
    trusted_resolver: TrustedQualificationResolver | None = None,
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
    if trusted_resolver is None:
        _fail("qualification requires independent trusted evidence acquisition")
    resolved = json.loads(json.dumps(dict(trusted_resolver.resolve())))
    resolved["profileFingerprints"] = {provider: item.fingerprint for provider, item in profiles.items()}
    if resolved != unsigned:
        _fail("signed qualification package does not match independently acquired trusted evidence")
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
        or not isinstance(task.get("version"), int) or isinstance(task.get("version"), bool) or task["version"] < 1
        or not re.fullmatch(r"[0-9a-f]{64}", str(task.get("fingerprint", "")))
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
            "provider", "number", "head", "commitSha", "base", "state", "isDraft", "merged", "checksReadbackFingerprint",
        }:
            _fail("trusted pull-request readback fields are invalid")
        record = record_by_provider.get(item["provider"])
        if (
            record is None or item["number"] in seen_prs or item["number"] != record["draftPrNumber"]
            or item["head"] != record["branch"] or item["commitSha"] != record["commitSha"]
            or item["base"] != "main" or item["state"] != "open"
            or item["isDraft"] is not True or item["merged"] is not False
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
        or hermes["disposition"] != "PASS"
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
