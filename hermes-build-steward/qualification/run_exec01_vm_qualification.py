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
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import quote

from hermes_steward.contracts import canonical_json, fingerprint
from hermes_steward.contracts import validate_dispatch_build_task
from hermes_steward.execution_contracts import (
    ExecutorProfile, ObservedExecutorIdentity, normalize_execution_request, validate_execution_result,
)
from hermes_steward.execution_coordinator import (
    ExecutionRecord, ExecutionStage, build_execution_audit_record,
)
from hermes_steward.execution_publisher import (
    GitHubTransport, _decode_metadata, deterministic_branch, deterministic_pr_identity,
)
from hermes_steward.store import StateStore
from hermes_steward.store import RecordNotFound, VersionedRecord
from hermes_steward.execution_coordinator import execution_record_from_dict
from hermes_steward.execution_runtime import BoundArtifactResolver
from hermes_steward.codec import record_from_dict
from hermes_steward.sharepoint_store import SharePointListStateStore
from hermes_steward.execution_publisher import UrlLibGitHubTransport


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


def validate_authoritative_hermes_evidence(
    raw: Mapping[str, Any], task: Mapping[str, Any], criteria: list[str],
    execution_record_fingerprints: list[str],
) -> dict[str, Any]:
    required = {
        "schemaVersion", "origin", "evidenceIdentity", "task", "criteriaResults",
        "executionRecordFingerprints", "originPolicyFingerprint", "disposition",
        "resultFingerprint",
    }
    if not isinstance(raw, Mapping) or set(raw) != required:
        _fail("qualification Hermes evidence is incomplete or malformed")
    value = json.loads(json.dumps(dict(raw)))
    results = value["criteriaResults"]
    if (
        value["schemaVersion"] != "1.0"
        or value["origin"] != "trusted-hermes-independent"
        or not isinstance(value["evidenceIdentity"], str)
        or not value["evidenceIdentity"].startswith("hermes://")
        or value["task"] != dict(task)
        or value["disposition"] != "PASS"
        or not re.fullmatch(r"[0-9a-f]{64}", str(value["originPolicyFingerprint"]))
        or not isinstance(results, list)
        or len(results) != len(criteria)
    ):
        _fail("qualification Hermes evidence identity or disposition is invalid")
    observed_criteria: list[str] = []
    for item in results:
        if (
            not isinstance(item, Mapping)
            or set(item) != {"criterion", "disposition", "evidenceReferences"}
            or item["disposition"] != "PASS"
            or not isinstance(item["criterion"], str)
            or not isinstance(item["evidenceReferences"], list)
            or not item["evidenceReferences"]
            or any(not isinstance(ref, str) or not ref for ref in item["evidenceReferences"])
        ):
            _fail("qualification Hermes criterion result is incomplete or non-PASS")
        observed_criteria.append(item["criterion"])
    if observed_criteria != criteria or len(set(observed_criteria)) != len(observed_criteria):
        _fail("qualification Hermes criterion authority is incomplete or duplicated")
    if sorted(value["executionRecordFingerprints"]) != sorted(execution_record_fingerprints):
        _fail("qualification Hermes evidence is not bound to the exact execution records")
    unsigned = {key: item for key, item in value.items() if key != "resultFingerprint"}
    if value["resultFingerprint"] != fingerprint(unsigned):
        _fail("qualification Hermes result fingerprint is invalid")
    return value


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
        status, commit_value = self.transport.request("GET", f"/commits/{commit_sha}")
        commit_payload = commit_value.get("commit") if status == 200 and isinstance(commit_value, Mapping) else None
        if not isinstance(commit_payload, Mapping) or commit_value.get("sha", commit_sha) != commit_sha:
            _fail("trusted GitHub commit readback is malformed or unrelated")
        try:
            commit_metadata = _decode_metadata(commit_payload.get("message"))
        except Exception as error:
            raise SystemExit("trusted GitHub commit metadata is missing or malformed") from error
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
        try:
            pr_metadata = _decode_metadata(pull_request.get("body"))
        except Exception as error:
            raise SystemExit("trusted GitHub pull-request metadata is missing or malformed") from error
        expected_metadata = record.get("publicationMetadata")
        expected_pr_metadata = (
            {**dict(expected_metadata), "commitSha": commit_sha}
            if isinstance(expected_metadata, Mapping) else None
        )
        if (
            not isinstance(expected_metadata, Mapping)
            or commit_metadata != dict(expected_metadata) or pr_metadata != expected_pr_metadata
            or head.get("ref") != branch or head.get("sha", commit_sha) != commit_sha
            or base.get("ref") != "main"
        ):
            _fail("trusted GitHub publication metadata conflicts with durable execution provenance")
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
        execution_store: StateStore[ExecutionRecord],
        result_store: StateStore[Mapping[str, Any]], probe_store: StateStore[Mapping[str, Any]],
        check_store: StateStore[Mapping[str, Any]],
        hermes_evidence_store: StateStore[Mapping[str, Any]],
        github_reader: TrustedGitHubQualificationReadPath,
        implementation_head_loader: Callable[[], str],
        profiles: Mapping[str, ExecutorProfile], artifact_resolver: Any,
        required_contract_sha256: str | None = None,
        qualification_context: Mapping[str, Any] | None = None,
    ):
        self.task_store = task_store
        self.task_key = task_key
        self.execution_store = execution_store
        self.result_store = result_store
        self.probe_store = probe_store
        self.check_store = check_store
        self.hermes_evidence_store = hermes_evidence_store
        self.github_reader = github_reader
        self.implementation_head_loader = implementation_head_loader
        self.profiles = dict(profiles)
        self.artifact_resolver = artifact_resolver
        self.required_contract_sha256 = required_contract_sha256
        self.qualification_context = dict(qualification_context or {})
        if set(self.profiles) != {"codex", "claude-code"}:
            _fail("qualification collector requires exact Codex and Claude profiles")
        _validate_qualification_context(self.qualification_context, observed_head=None)

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
        if task["repository"] != REPOSITORY or task["baseRef"] != BASE_SHA:
            _fail("qualification task repository or authorized base is invalid")
        if (
            self.required_contract_sha256 is not None
            and task["acceptanceContractHash"] != self.required_contract_sha256
        ):
            _fail("qualification task is not bound to the canonical EXEC-01 contract")
        authority_audit = getattr(value, "audit", None)
        task_fingerprint = fingerprint(task)
        task_identity = {"id": task["taskId"], "version": task["taskVersion"], "fingerprint": task_fingerprint}
        artifacts = self.artifact_resolver.resolve(task)
        durable_values = self._values(self.result_store)
        result_values = [
            item for item in durable_values
            if item.get("schemaVersion") == "1.0" and item.get("taskFingerprint") == task_fingerprint
            and "disposition" in item
        ]
        audit_values = [
            item for item in durable_values
            if item.get("schemaVersion") == "1.0" and isinstance(item.get("task"), Mapping)
            and item["task"].get("fingerprint") == task_fingerprint
            and isinstance(item.get("attempt"), Mapping)
            and isinstance(item.get("publication"), Mapping)
            and isinstance(item.get("executor"), Mapping)
        ]
        results: dict[tuple[str, str], dict[str, Any]] = {}
        for item in result_values:
            identity = (str(item.get("taskFingerprint")), str(item.get("attemptId")))
            if identity in results:
                _fail("qualification contains a duplicate normalized result identity")
            results[identity] = item
        audits: dict[str, dict[str, Any]] = {}
        for item in audit_values:
            attempt = item.get("attempt")
            attempt_id = attempt.get("attemptId") if isinstance(attempt, Mapping) else None
            if not isinstance(attempt_id, str) or attempt_id in audits:
                _fail("qualification contains a duplicate or malformed audit identity")
            audits[attempt_id] = item
        execution_values: list[ExecutionRecord] = []
        seen_execution_identities: set[str] = set()
        seen_execution_attempts: set[str] = set()
        for versioned in self.execution_store.list_records():
            execution = versioned.value
            if not isinstance(execution, ExecutionRecord):
                _fail("qualification execution-state store contains a malformed record")
            if execution.task_fingerprint != task_fingerprint:
                continue
            if execution.identity in seen_execution_identities or execution.attempt_id in seen_execution_attempts:
                _fail("qualification contains a duplicate execution record identity")
            seen_execution_identities.add(execution.identity)
            seen_execution_attempts.add(execution.attempt_id)
            execution_values.append(execution)
        head_sha = self.implementation_head_loader()
        if not re.fullmatch(r"[0-9a-f]{40}", head_sha):
            _fail("qualification implementation head is invalid")
        _validate_qualification_context(self.qualification_context, observed_head=head_sha)
        records, pull_requests = [], []
        covered_providers: set[str] = set()
        for execution in execution_values:
            if execution.stage != ExecutionStage.RESULT_PERSISTED:
                _fail("qualification execution record is not durably RESULT_PERSISTED")
            audit = audits.get(execution.attempt_id)
            result = results.get((task_fingerprint, execution.attempt_id))
            if audit is None or result is None:
                _fail("qualification execution record is missing its normalized result or audit")
            attempt, publication, executor = audit["attempt"], audit["publication"], audit["executor"]
            draft_pr, repository = publication.get("draftPr"), audit.get("repository")
            audit_result = audit.get("result")
            provider = executor.get("provider")
            selected = self.profiles.get(provider) if isinstance(provider, str) else None
            observed_raw = executor.get("observedIdentity")
            if (
                selected is None or provider in covered_providers
                or executor.get("profileId") != selected.profile_id
                or executor.get("profileFingerprint") != selected.fingerprint
                or not isinstance(observed_raw, Mapping)
            ):
                _fail("durable executor profile provenance is invalid or duplicated")
            try:
                observed = ObservedExecutorIdentity(
                    image=observed_raw["image"], runtime_wrapper_digest=observed_raw["runtimeWrapperDigest"],
                    executable_digest=observed_raw["executableDigest"], executable_version=observed_raw["executableVersion"],
                    launcher_version=observed_raw["launcherVersion"], model=observed_raw["model"],
                    gateway_implementation_digest=observed_raw["gatewayImplementationDigest"],
                    gateway_policy_digest=observed_raw["gatewayPolicyDigest"],
                )
                lease = SimpleNamespace(
                    attempt_id=attempt["attemptId"], lease_id=attempt["leaseId"],
                    fencing_token=attempt["fencingToken"],
                )
                request = normalize_execution_request(
                    task, task_fingerprint, selected, lease, artifacts, observed,
                    executor.get("fallbackContext"),
                )
                normalized = validate_execution_result(result, request, allow_trusted_publication=True)
            except (KeyError, TypeError, ValueError) as error:
                raise SystemExit("qualification normalized execution result is invalid") from error
            if authority_audit is not None:
                historical = [
                    event for event in authority_audit
                    if isinstance(event, Mapping) and event.get("event") in {"LEASE_ACQUIRED", "FALLBACK_ATTEMPT_CLAIMED"}
                    and isinstance(event.get("details"), Mapping)
                    and event["details"].get("attemptId") == request.attempt_id
                    and event["details"].get("leaseId") == request.lease_id
                    and event["details"].get("fencingToken") == request.fencing_token
                ]
                if len(historical) != 1:
                    _fail("qualification attempt lease/fence is absent or duplicated in durable Hermes authority")
            if (
                not isinstance(draft_pr, Mapping) or not isinstance(repository, Mapping)
                or not isinstance(audit_result, Mapping) or repository.get("url") != task["repository"]
                or repository.get("baseSha") != task["baseRef"]
                or normalized.get("disposition") != audit_result.get("disposition")
                or execution.execution_result != normalized
                or execution.change_set is None or execution.publication is None
                or list(execution.change_set.changed_paths) != normalized["changedPaths"]
                or execution.change_set.patch_digest != normalized["patchDigest"]
                or execution.publication.branch != normalized["branch"]
                or execution.publication.commit_sha != normalized["commitSha"]
                or execution.publication.draft_pr.get("number") != normalized["draftPr"].get("number")
                or build_execution_audit_record(request, execution) != audit
            ):
                _fail("durable execution result, trusted change set, publication, and audit do not agree")
            expected_branch = deterministic_branch(request)
            expected_pr_identity = deterministic_pr_identity(request)
            if execution.publication.branch != expected_branch or execution.publication.pr_identity != expected_pr_identity:
                _fail("durable publication does not use deterministic task identity")
            metadata = {
                "taskFingerprint":task_fingerprint, "baseSha":task["baseRef"],
                "patchDigest":execution.change_set.patch_digest, "attemptId":execution.attempt_id,
                "leaseId":request.lease_id, "fencingToken":request.fencing_token,
                "prIdentity":expected_pr_identity, "specificationHash":task["specificationHash"],
                "acceptanceContractHash":task["acceptanceContractHash"],
                "executorProfileFingerprint":selected.fingerprint,
                "branch":expected_branch,
            }
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
            github_record = {**record, "publicationMetadata": metadata}
            github_readback = self.github_reader.read(provider, github_record)
            if any(
                item["number"] == github_readback["number"]
                or item["head"] == github_readback["head"]
                for item in pull_requests
            ):
                _fail("qualification contains a duplicate pull request identity")
            pull_requests.append(github_readback)
            covered_providers.add(provider)

        if len(execution_values) != 2 or len(results) != 2 or len(audits) != 2 or covered_providers != set(self.profiles):
            _fail("qualification requires exactly one complete execution/result/audit record per provider")

        raw_probes = [item for item in self._values(self.probe_store) if item.get("taskFingerprint") == task_fingerprint]
        probes = []
        probe_identities: set[tuple[Any, Any]] = set()
        required_observations = {
            "providerCredentialReadable": False, "publisherCredentialReadable": False,
            "hermesCredentialReadable": False, "coordinatorSecretsReadable": False,
            "networkPolicyEnforced": True, "resourcePolicyEnforced": True,
            "workspaceBoundaryEnforced": True,
        }
        for probe in raw_probes:
            if set(probe) != {
                "provider", "attemptId", "taskFingerprint", "profileFingerprint", "origin",
                "sourceIdentity", "observations", "evidenceFingerprint",
            }:
                _fail("qualification containment probe authority record is malformed")
            unsigned_probe = {key: value for key, value in probe.items() if key != "evidenceFingerprint"}
            if (
                probe.get("origin") != "trusted-runtime-probe"
                or not isinstance(probe.get("sourceIdentity"), str)
                or not probe["sourceIdentity"].startswith("runtime-probe://")
                or probe.get("observations") != required_observations
                or probe.get("evidenceFingerprint") != fingerprint(unsigned_probe)
            ):
                _fail("qualification containment probe evidence is asserted or unbound")
            identity = (probe.get("provider"), probe.get("attemptId"))
            if identity in probe_identities:
                _fail("qualification contains a duplicate containment probe identity")
            probe_identities.add(identity)
            probes.append({key: probe[key] for key in (
                "provider", "attemptId", "taskFingerprint", "profileFingerprint", "origin", "evidenceFingerprint"
            )})
        hermes_values = [
            item for item in self._values(self.hermes_evidence_store)
            if isinstance(item.get("task"), Mapping)
            and item["task"].get("fingerprint") == task_fingerprint
        ]
        if len(hermes_values) != 1:
            _fail("qualification requires exactly one independently acquired Hermes disposition")
        hermes_evidence = validate_authoritative_hermes_evidence(
            hermes_values[0], task_identity, list(task["acceptanceCriteria"]),
            [item["recordFingerprint"] for item in records],
        )
        checks: dict[str, Any] = {}
        for item in self._values(self.check_store):
            if item.get("taskFingerprint") != task_fingerprint:
                continue
            if set(item) != {
                "taskFingerprint", "name", "origin", "sourceIdentity",
                "supportingEvidenceFingerprints", "evidenceFingerprint",
            }:
                _fail("qualification check authority record is malformed")
            unsigned_check = {key: value for key, value in item.items() if key != "evidenceFingerprint"}
            if (
                item.get("origin") not in {"trusted-runtime-probe", "trusted-github-readback", "trusted-hermes-independent"}
                or not isinstance(item.get("sourceIdentity"), str) or "://" not in item["sourceIdentity"]
                or not isinstance(item.get("supportingEvidenceFingerprints"), list)
                or not item["supportingEvidenceFingerprints"]
                or any(not re.fullmatch(r"[0-9a-f]{64}", str(value)) for value in item["supportingEvidenceFingerprints"])
                or item.get("evidenceFingerprint") != fingerprint(unsigned_check)
            ):
                _fail("qualification check evidence is asserted or unbound")
            if item["name"] in checks:
                _fail("qualification check authority contains duplicates")
            checks[str(item["name"])] = {
                "origin": item["origin"], "evidenceFingerprint": item["evidenceFingerprint"]
            }
        return {
            "buildId": "EXEC-01", "contractSha256": CONTRACT_SHA256,
            "classification": "synthetic-non-client", "repository": task["repository"],
            "baseSha": task["baseRef"], "headSha": head_sha, "task": task_identity,
            "qualificationContext": {**self.qualification_context, "observedHeadSha": head_sha},
            "profileFingerprints": {}, "executionRecords": records,
            "pullRequestReadback": pull_requests, "containmentProbeEvidence": probes,
            "checks": checks, "hermesEvidence": hermes_evidence,
            "restrictions": {"draftPrOnly": True, "merged": False, "deployment": False,
                             "productionActivation": False, "clientDocuments": False},
        }

    def collect_and_sign(self, profiles: Mapping[str, ExecutorProfile], attestation_key: bytes) -> dict:
        value = dict(self.resolve())
        value["profileFingerprints"] = {provider: item.fingerprint for provider, item in profiles.items()}
        return sign_evidence(value, attestation_key)


def _fail(message: str) -> None:
    raise SystemExit(message)


def _validate_qualification_context(raw: Mapping[str, Any], observed_head: str | None) -> None:
    required = {
        "mode", "environmentId", "runId", "expectedHeadSha", "profileClass", "signingPurpose",
        "taskStoreIdentity", "executionStoreIdentity", "resultStoreIdentity", "probeStoreIdentity",
        "checkStoreIdentity", "hermesStoreIdentity",
    }
    if not isinstance(raw, Mapping) or set(raw) != required:
        _fail("qualification context is incomplete or malformed")
    mode = raw["mode"]
    expected = {
        "CODE_QA": ("deterministic-emulator", "EXEC01_CODE_QA_EVIDENCE"),
        "LIVE_HOSTINGER": ("production-allowlisted", "EXEC01_HOSTINGER_QUALIFICATION"),
    }
    if mode not in expected or (raw["profileClass"], raw["signingPurpose"]) != expected[mode]:
        _fail("qualification mode, profile class, or signing purpose is invalid")
    if any(not isinstance(raw[field], str) or not raw[field] for field in required - {"mode", "expectedHeadSha"}):
        _fail("qualification context identities are invalid")
    if not re.fullmatch(r"[0-9a-f]{40}", str(raw["expectedHeadSha"])):
        _fail("qualification expected implementation head is invalid")
    store_fields = (
        "taskStoreIdentity", "executionStoreIdentity", "resultStoreIdentity",
        "probeStoreIdentity", "checkStoreIdentity", "hermesStoreIdentity",
    )
    if mode == "CODE_QA" and (
        raw["environmentId"] != "exec01-code-qa"
        or any(not raw[field].startswith("file:") for field in store_fields)
    ):
        _fail("code-QA evidence cannot claim live Hostinger authority")
    if mode == "LIVE_HOSTINGER" and (
        raw["environmentId"] != "hostinger-production"
        or any(not raw[field].startswith("sharepoint:") for field in store_fields)
    ):
        _fail("live Hostinger qualification requires authoritative SharePoint store identities")
    if observed_head is not None and observed_head != raw["expectedHeadSha"]:
        _fail("qualification observed implementation head does not match the approved expected head")


def verify_evidence(
    profiles: dict[str, ExecutorProfile], evidence: dict, *, attestation_key: bytes,
    trusted_resolver: TrustedQualificationResolver | None = None,
) -> dict:
    if not isinstance(evidence, dict) or set(evidence) != {
        "buildId", "contractSha256", "classification", "repository", "baseSha", "headSha", "task",
        "profileFingerprints", "executionRecords", "pullRequestReadback", "containmentProbeEvidence",
        "checks", "hermesEvidence", "restrictions", "qualificationContext", "attestation",
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
    context = evidence.get("qualificationContext")
    if not isinstance(context, Mapping) or set(context) != {
        "mode", "environmentId", "runId", "expectedHeadSha", "observedHeadSha", "profileClass",
        "signingPurpose", "taskStoreIdentity", "executionStoreIdentity", "resultStoreIdentity",
        "probeStoreIdentity", "checkStoreIdentity", "hermesStoreIdentity",
    }:
        _fail("qualification context evidence is malformed")
    configured_context = {key: value for key, value in context.items() if key != "observedHeadSha"}
    _validate_qualification_context(configured_context, observed_head=context.get("observedHeadSha"))
    if context["observedHeadSha"] != evidence["headSha"]:
        _fail("qualification context head does not match acquired implementation head")
    if context["mode"] == "LIVE_HOSTINGER" and any(
        "synthetic" in (profile.model + profile.runtime_name + profile.runtime_version + profile.image).lower()
        for profile in profiles.values()
    ):
        _fail("live Hostinger qualification rejects synthetic executor profiles")
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
    criteria = [
        item.get("criterion") for item in hermes.get("criteriaResults", [])
    ] if isinstance(hermes, Mapping) else []
    validate_authoritative_hermes_evidence(
        hermes, task, criteria, [item["recordFingerprint"] for item in records]
    )
    if evidence.get("restrictions") != {
        "draftPrOnly": True, "merged": False, "deployment": False,
        "productionActivation": False, "clientDocuments": False,
    }:
        _fail("qualification restrictions are invalid")
    return {
        "status": "QUALIFIED" if context["mode"] == "LIVE_HOSTINGER" else "CODE_QA_EVIDENCE_VERIFIED",
        "qualificationMode": context["mode"], "taskFingerprint": task["fingerprint"],
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


class JsonFileStateStore:
    """Read-only synthetic authority used by code-QA CLI fixtures."""

    def __init__(self, path: Path, decoder: Callable[[Mapping[str, Any]], Any]):
        raw = _read(str(path))
        records = raw.get("records")
        if set(raw) != {"records"} or not isinstance(records, list):
            _fail("qualification file store is malformed")
        self._records: dict[str, VersionedRecord[Any]] = {}
        for index, item in enumerate(records):
            if not isinstance(item, Mapping) or set(item) != {"key", "value"} or not isinstance(item["key"], str):
                _fail("qualification file-store record is malformed")
            if item["key"] in self._records:
                _fail("qualification file store contains a duplicate key")
            if not isinstance(item["value"], Mapping):
                _fail("qualification file-store value is malformed")
            self._records[item["key"]] = VersionedRecord(decoder(item["value"]), f'"file-{index}"')

    def get(self, key: str) -> VersionedRecord[Any]:
        if key not in self._records:
            raise RecordNotFound(key)
        return self._records[key]

    def list_records(self) -> list[VersionedRecord[Any]]:
        return list(self._records.values())

    def create(self, key: str, value: Any) -> VersionedRecord[Any]:
        del key, value
        raise PermissionError("qualification file authority is read-only")

    def compare_and_swap(self, key: str, expected_etag: str, value: Any) -> VersionedRecord[Any]:
        del key, expected_etag, value
        raise PermissionError("qualification file authority is read-only")


class FileGitHubQualificationTransport:
    def __init__(self, path: Path):
        value = _read(str(path))
        if set(value) != {"branches", "commits", "pullRequests", "checks"} or any(
            not isinstance(value[field], Mapping) for field in value
        ):
            _fail("qualification GitHub file readback is malformed")
        self.value = value

    def request(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> tuple[int, Any]:
        del body
        if method != "GET":
            return 403, {}
        from urllib.parse import unquote
        if path.startswith("/git/ref/heads/"):
            value = self.value["branches"].get(unquote(path.rsplit("/", 1)[-1]))
        elif path.startswith("/pulls?"):
            value = self.value["pullRequests"].get(unquote(path.split(":", 1)[1]))
        elif path.endswith("/check-runs"):
            value = self.value["checks"].get(path.split("/")[2])
        elif path.startswith("/commits/"):
            value = self.value["commits"].get(path.split("/")[2])
        else:
            value = None
        return (200, value) if value is not None else (404, {})


def _resolved_path(base: Path, value: Any, field: str) -> Path:
    if not isinstance(value, str) or not value:
        _fail(f"qualification {field} path is invalid")
    path = Path(value)
    return (path if path.is_absolute() else base / path).resolve()


def _store_from_config(
    raw: Any, base: Path, decoder: Callable[[Mapping[str, Any]], Any], *,
    production: bool, status_getter: Callable[[Any], str] | None = None,
) -> StateStore[Any]:
    if not isinstance(raw, Mapping) or raw.get("kind") not in {"file", "sharepoint"}:
        _fail("qualification store configuration is invalid")
    if raw["kind"] == "file":
        if production or set(raw) not in ({"kind", "path"}, {"kind", "path", "key"}):
            _fail("file qualification stores are restricted to synthetic code QA")
        return JsonFileStateStore(_resolved_path(base, raw["path"], "store"), decoder)
    expected = {"kind", "endpoint", "namespace", "environmentId", "tokenEnvironment"}
    observed_fields = set(raw) - ({"key"} if "key" in raw else set())
    if observed_fields != expected:
        _fail("SharePoint qualification store configuration is invalid")
    token_name = raw["tokenEnvironment"]
    if not isinstance(token_name, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{2,127}", token_name):
        _fail("SharePoint qualification token environment is invalid")
    if production and (
        token_name != "EXEC01_GRAPH_TOKEN"
        or raw.get("environmentId") != "hostinger-production"
        or not isinstance(raw.get("namespace"), str)
        or not raw["namespace"].startswith("prod.")
    ):
        _fail("production SharePoint qualification authority binding is invalid")
    return SharePointListStateStore(
        raw["endpoint"], raw["namespace"], raw["environmentId"],
        lambda name=token_name: os.environ.get(name, ""), record_encoder=lambda value: dict(value),
        record_decoder=decoder, status_getter=status_getter,
    )


def build_qualification_runtime(config_path: str) -> tuple[DurableQualificationEvidenceCollector, dict[str, ExecutorProfile], bytes]:
    path = Path(config_path).resolve()
    raw = _read(str(path))
    expected = {
        "schemaVersion", "classification", "profilesFile", "attestationKeyFile",
        "implementationRepositoryPath", "taskStore", "executionStore", "resultStore",
        "probeStore", "checkStore", "hermesEvidenceStore", "artifacts", "githubReadback",
        "qualificationContext",
    }
    if set(raw) != expected or raw["schemaVersion"] != "1.0" or raw["classification"] not in {
        "synthetic-code-qa", "production-hostinger-qualification",
    }:
        _fail("qualification runtime configuration fields are invalid")
    base = path.parent
    production = raw["classification"] == "production-hostinger-qualification"
    context = raw["qualificationContext"]
    _validate_qualification_context(context, observed_head=None)
    if (production and context["mode"] != "LIVE_HOSTINGER") or (
        not production and context["mode"] != "CODE_QA"
    ):
        _fail("qualification environment classification and mode conflict")
    profiles = load_profiles(str(_resolved_path(base, raw["profilesFile"], "profiles")))
    if production and any(
        "synthetic" in (profile.model + profile.runtime_name + profile.runtime_version + profile.image).lower()
        for profile in profiles.values()
    ):
        _fail("live Hostinger qualification rejects synthetic executor profiles")
    task_raw = raw["taskStore"]
    for context_field, store_field in (
        ("taskStoreIdentity", "taskStore"), ("executionStoreIdentity", "executionStore"),
        ("resultStoreIdentity", "resultStore"), ("probeStoreIdentity", "probeStore"),
        ("checkStoreIdentity", "checkStore"), ("hermesStoreIdentity", "hermesEvidenceStore"),
    ):
        configured_store = raw[store_field]
        if production and context[context_field] != f"sharepoint:{configured_store.get('namespace')}":
            _fail("qualification context store identity does not match configured SharePoint authority")
    task_store = _store_from_config(task_raw, base, record_from_dict if production else lambda value: dict(value), production=production)
    task_key = task_raw.get("key") if isinstance(task_raw, Mapping) else None
    if not isinstance(task_key, str) or not task_key:
        _fail("qualification task-store key is required")
    execution_store = _store_from_config(raw["executionStore"], base, execution_record_from_dict, production=production)
    identity = lambda value: dict(value)
    result_store = _store_from_config(raw["resultStore"], base, identity, production=production)
    probe_store = _store_from_config(raw["probeStore"], base, identity, production=production)
    check_store = _store_from_config(raw["checkStore"], base, identity, production=production)
    hermes_store = _store_from_config(raw["hermesEvidenceStore"], base, identity, production=production)
    artifact_raw = raw["artifacts"]
    if not isinstance(artifact_raw, Mapping) or set(artifact_raw) != {
        "pmInstructionFile", "specificationFile", "acceptanceContractFile",
    }:
        _fail("qualification artifact configuration is invalid")
    task_value = task_store.get(task_key).value
    task = getattr(task_value, "task", task_value)
    if not isinstance(task, Mapping):
        _fail("qualification task authority is malformed")
    artifact_resolver = BoundArtifactResolver(
        pm_ref=task["originatingPmInstructionRef"],
        pm_instruction=_resolved_path(base, artifact_raw["pmInstructionFile"], "PM instruction").read_bytes(),
        specification_ref=task["specificationRef"],
        specification=_resolved_path(base, artifact_raw["specificationFile"], "specification").read_bytes(),
        acceptance_contract_ref=task["acceptanceContractRef"],
        acceptance_contract=_resolved_path(base, artifact_raw["acceptanceContractFile"], "acceptance contract").read_bytes(),
    )
    github_raw = raw["githubReadback"]
    if not isinstance(github_raw, Mapping) or github_raw.get("repository") != "amengko-stack/sandiva":
        _fail("qualification GitHub readback configuration is invalid")
    if github_raw.get("kind") == "file" and not production and set(github_raw) == {"kind", "repository", "path"}:
        github_transport: GitHubTransport = FileGitHubQualificationTransport(
            _resolved_path(base, github_raw["path"], "GitHub readback")
        )
    elif github_raw.get("kind") == "github" and production and set(github_raw) == {"kind", "repository", "tokenEnvironment"}:
        token_name = github_raw["tokenEnvironment"]
        if token_name != "EXEC01_GITHUB_READ_TOKEN":
            _fail("qualification GitHub read credential source is invalid")
        github_transport = UrlLibGitHubTransport(
            github_raw["repository"], lambda name=token_name: os.environ.get(name, "")
        )
    else:
        _fail("qualification GitHub readback mode is invalid")
    repository = _resolved_path(base, raw["implementationRepositoryPath"], "implementation repository")
    def load_head() -> str:
        try:
            origin = subprocess.check_output(["git", "-C", str(repository), "remote", "get-url", "origin"], text=True, stderr=subprocess.PIPE).strip()
            head = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True, stderr=subprocess.PIPE).strip()
        except (OSError, subprocess.CalledProcessError) as error:
            raise SystemExit("qualification implementation Git identity is unavailable") from error
        if origin not in {REPOSITORY, REPOSITORY + ".git"} or not re.fullmatch(r"[0-9a-f]{40}", head):
            _fail("qualification implementation Git identity is unapproved")
        return head
    collector = DurableQualificationEvidenceCollector(
        task_store=task_store, task_key=task_key, execution_store=execution_store,
        result_store=result_store, probe_store=probe_store, check_store=check_store,
        hermes_evidence_store=hermes_store,
        github_reader=TrustedGitHubQualificationReadPath("amengko-stack/sandiva", github_transport),
        implementation_head_loader=load_head, profiles=profiles, artifact_resolver=artifact_resolver,
        required_contract_sha256=CONTRACT_SHA256 if production else None,
        qualification_context=context,
    )
    key = _read_attestation_key(str(_resolved_path(base, raw["attestationKeyFile"], "attestation key")))
    return collector, profiles, key


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="mode", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--profiles", required=True)
    collect = commands.add_parser("collect")
    collect.add_argument("--config", required=True)
    collect.add_argument("--output", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("--config", required=True)
    verify.add_argument("--evidence", required=True)
    arguments = parser.parse_args()
    if arguments.mode == "plan":
        value = qualification_plan(load_profiles(arguments.profiles))
    else:
        collector, profiles, key = build_qualification_runtime(arguments.config)
        if arguments.mode == "collect":
            value = collector.collect_and_sign(profiles, key)
            output = Path(arguments.output).resolve()
            output.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")), encoding="utf-8")
        else:
            value = verify_evidence(
                profiles, _read(arguments.evidence), attestation_key=key, trusted_resolver=collector,
            )
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
