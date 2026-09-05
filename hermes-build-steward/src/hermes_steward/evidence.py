from __future__ import annotations

import json
import re
from typing import Callable
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

from .sharepoint_store import GraphTransport, UrlLibGraphTransport


class EvidenceAccessDenied(PermissionError):
    pass


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
