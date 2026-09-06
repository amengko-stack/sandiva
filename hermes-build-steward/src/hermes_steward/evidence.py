from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from hashlib import sha256
from types import MappingProxyType
from typing import Any, Callable, Mapping, Protocol, Sequence
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen



class GraphTransport(Protocol):
    def request(
        self, method: str, url: str, headers: Mapping[str, str], body: str | None = None
    ) -> tuple[int, Mapping[str, str], bytes]: ...


class UrlLibGraphTransport:
    def request(
        self, method: str, url: str, headers: Mapping[str, str], body: str | None = None
    ) -> tuple[int, Mapping[str, str], bytes]:
        request = Request(
            url,
            data=body.encode("utf-8") if body is not None else None,
            headers=dict(headers),
            method=method,
        )
        try:
            with urlopen(request, timeout=30) as response:
                return response.status, dict(response.headers.items()), response.read()
        except HTTPError as error:
            return error.code, dict(error.headers.items()), error.read()


class EvidenceAccessDenied(PermissionError):
    pass


_TRUSTED_ACQUISITION_PROOF = object()


@dataclass(frozen=True)
class TrustedEvidence:
    """Opaque coordinator-side evidence; repository JSON cannot create this acquisition marker."""

    category: str
    evidence_ref: str
    kind: str
    source: str
    result: str
    trusted_origin: str
    criteria: tuple[str, ...]
    details: Mapping[str, Any]
    _acquisition_proof: object | None = field(default=None, repr=False, compare=False)

    @property
    def acquired_by_trusted_path(self) -> bool:
        return self._acquisition_proof is _TRUSTED_ACQUISITION_PROOF

    def as_record(self) -> dict[str, Any]:
        return {
            "evidenceRef": self.evidence_ref,
            "kind": self.kind,
            "source": self.source,
            "result": self.result,
            "trustedOrigin": self.trusted_origin,
            "criteria": list(self.criteria),
            "details": dict(self.details),
        }


def coordinator_observation_evidence(
    *, evidence_ref: str, kind: str, source: str, result: str, criteria: Sequence[str], details: Mapping[str, Any]
) -> TrustedEvidence:
    if kind not in {"coordinator-observation", "lease-fencing", "runtime-state", "coordinator-audit", "partner-gate"}:
        raise ValueError("trusted coordinator evidence kind is invalid")
    return TrustedEvidence(
        category="deterministic",
        evidence_ref=evidence_ref,
        kind=kind,
        source=source,
        result=result,
        trusted_origin="TRUSTED_COORDINATOR",
        criteria=tuple(criteria),
        details=MappingProxyType(dict(details)),
        _acquisition_proof=_TRUSTED_ACQUISITION_PROOF,
    )


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _safe_graph_download(url: str, token: str) -> bytes:
    request = Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/octet-stream"}, method="GET")
    try:
        with build_opener(_NoRedirect()).open(request, timeout=30) as response:
            return response.read()
    except HTTPError as error:
        if error.code not in {301, 302, 303, 307, 308}:
            raise RuntimeError(f"Control Tower evidence read failed with HTTP {error.code}") from error
        location = error.headers.get("Location")
        if not location or urlparse(location).scheme != "https":
            raise RuntimeError("Graph evidence redirect was absent or not HTTPS") from error
        # The Graph bearer token is intentionally not forwarded to the pre-authenticated download URL.
        with urlopen(Request(location, headers={"Accept": "application/octet-stream"}, method="GET"), timeout=30) as response:
            return response.read()


class ControlTowerEvidenceReader:
    def __init__(self, token_provider: Callable[[], str], *, allowed_drive_ids: set[str], transport: GraphTransport | None = None):
        if not allowed_drive_ids:
            raise ValueError("at least one approved Control Tower drive ID is required")
        self.token_provider = token_provider
        self.allowed_drive_ids = frozenset(allowed_drive_ids)
        self.transport = transport

    def read(self, reference: str) -> bytes:
        parsed = urlparse(reference)
        parts = [unquote(part) for part in parsed.path.strip("/").split("/")]
        valid_path = (
            len(parts) == 6 and parts[0] == "v1.0" and parts[1] == "drives"
            and parts[2] in self.allowed_drive_ids and parts[3] == "items"
            and bool(parts[4]) and "/" not in parts[4] and parts[5] == "content"
        )
        if (
            parsed.scheme != "https" or parsed.netloc.lower() != "graph.microsoft.com"
            or not valid_path or parsed.params or parsed.query or parsed.fragment
        ):
            raise EvidenceAccessDenied("Control Tower evidence reference must be a Microsoft Graph driveItem content URL")
        token = self.token_provider()
        if self.transport is None:
            return _safe_graph_download(reference, token)
        status, _, raw = self.transport.request(
            "GET", reference, {"Authorization": f"Bearer {token}", "Accept": "application/octet-stream"}, None,
        )
        if status != 200:
            raise RuntimeError(f"Control Tower evidence read failed with HTTP {status}")
        return raw


class GitHubEvidenceReader:
    def __init__(self, *, token_provider: Callable[[], str] | None = None, transport: GraphTransport | None = None):
        self.token_provider = token_provider
        self.transport = transport or UrlLibGraphTransport()

    def _get(self, url: str) -> dict:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "sandiva-hermes-build-steward/0.1.0",
        }
        if self.token_provider is not None:
            headers["Authorization"] = f"Bearer {self.token_provider()}"
        status, _, raw = self.transport.request("GET", url, headers, None)
        if status != 200:
            raise RuntimeError(f"GitHub evidence read failed with HTTP {status}")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise RuntimeError("GitHub evidence response is not an object")
        return value

    def commit_and_checks(self, repository: str, commit_sha: str) -> dict:
        parsed = urlparse(repository)
        parts = parsed.path.strip("/").split("/")
        if parsed.scheme != "https" or parsed.netloc.lower() != "github.com" or len(parts) != 2:
            raise EvidenceAccessDenied("repository must be a canonical github.com owner/repository URL")
        if not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
            raise EvidenceAccessDenied("GitHub evidence requires an immutable commit SHA")
        owner, name = (quote(part, safe="") for part in parts)
        sha = quote(commit_sha, safe="")
        base = f"https://api.github.com/repos/{owner}/{name}/commits/{sha}"
        return {"commit": self._get(base), "checks": self._get(base + "/check-runs")}


def retrieve_github_ci_evidence(
    reader: GitHubEvidenceReader,
    repository: str,
    commit_sha: str,
    criteria: Sequence[str],
) -> TrustedEvidence:
    """Acquire immutable CI evidence through the coordinator-owned GitHub reader."""

    payload = reader.commit_and_checks(repository, commit_sha)
    commit = payload.get("commit")
    checks = payload.get("checks")
    if not isinstance(commit, dict) or commit.get("sha") != commit_sha:
        raise RuntimeError("GitHub commit evidence does not match the requested immutable commit")
    if not isinstance(checks, dict) or not isinstance(checks.get("check_runs"), list) or not checks["check_runs"]:
        raise RuntimeError("GitHub CI evidence contains no check runs")
    normalized_checks = []
    for check in checks["check_runs"]:
        if (
            not isinstance(check, dict)
            or check.get("head_sha") != commit_sha
            or not isinstance(check.get("id"), int)
            or isinstance(check.get("id"), bool)
            or not isinstance(check.get("name"), str)
            or not check["name"].strip()
            or check.get("conclusion") not in {"success", "failure", "cancelled", "timed_out", "action_required"}
        ):
            raise RuntimeError("GitHub CI check evidence is malformed or not bound to the requested commit")
        normalized_checks.append(
            {"id": check["id"], "name": check["name"], "conclusion": check["conclusion"], "headSha": commit_sha}
        )
    normalized_checks.sort(key=lambda item: (item["id"], item["name"]))
    conclusion = "PASS" if all(item["conclusion"] == "success" for item in normalized_checks) else "FAIL"
    identity_material = json.dumps(normalized_checks, sort_keys=True, separators=(",", ":")).encode("utf-8")
    parsed = urlparse(repository)
    repository_name = parsed.path.strip("/")
    evidence_ref = f"github-ci://{repository_name}/commit/{commit_sha}/checks/{sha256(identity_material).hexdigest()}"
    return TrustedEvidence(
        category="deterministic",
        evidence_ref=evidence_ref,
        kind="github-ci",
        source=f"https://api.github.com/repos/{repository_name}/commits/{commit_sha}/check-runs",
        result=conclusion,
        trusted_origin="TRUSTED_EXTERNAL_SYSTEM",
        criteria=tuple(criteria),
        details=MappingProxyType(
            {"commitSha": commit_sha, "commitUrl": commit.get("html_url"), "checkRuns": normalized_checks}
        ),
        _acquisition_proof=_TRUSTED_ACQUISITION_PROOF,
    )
