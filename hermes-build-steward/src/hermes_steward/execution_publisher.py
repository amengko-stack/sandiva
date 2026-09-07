from __future__ import annotations

import base64
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping, Protocol
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .execution_contracts import NormalizedExecutionRequest
from .prepublication import ChangeSet


class PublisherAuthorityDenied(PermissionError):
    pass


class PublicationConflict(RuntimeError):
    pass


class StalePublicationAuthority(RuntimeError):
    pass


class PublisherAuthority:
    """The deliberately small authority envelope of the trusted publisher."""

    _ALLOWED = frozenset({
        "create_task_commit",
        "push_task_branch",
        "upsert_task_draft_pr",
        "read_task_metadata",
    })

    def require(self, capability: str) -> None:
        if capability not in self._ALLOWED:
            raise PublisherAuthorityDenied(f"publisher authority denies {capability}")


class GitHubGateway(Protocol):
    def get_branch(self, branch: str) -> Mapping[str, Any] | None: ...

    def create_commit(
        self, workspace: str, branch: str, message: str, metadata: Mapping[str, Any]
    ) -> str: ...

    def push_task_branch(
        self, branch: str, commit_sha: str, metadata: Mapping[str, Any]
    ) -> None: ...

    def get_pull_request(self, pr_identity: str) -> Mapping[str, Any] | None: ...

    def create_draft_pull_request(
        self,
        branch: str,
        base: str,
        title: str,
        body: str,
        metadata: Mapping[str, Any],
    ) -> Mapping[str, Any]: ...


class GitHubTransport(Protocol):
    def request(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> tuple[int, Any]: ...


class UrlLibGitHubTransport:
    """Repository-scoped GitHub REST transport owned only by the trusted publisher."""

    def __init__(self, repository: str, credential_provider: Callable[[], str]):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("GitHub repository identity is invalid")
        self.repository = repository
        self._credential_provider = credential_provider

    def request(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> tuple[int, Any]:
        if not path.startswith("/") or ".." in path:
            raise PublicationConflict("GitHub API path is invalid")
        token = self._credential_provider()
        if not token:
            raise PublicationConflict("GitHub publisher credential is unavailable")
        request = Request(
            f"https://api.github.com/repos/{self.repository}{path}",
            data=None if body is None else json.dumps(dict(body), separators=(",", ":")).encode("utf-8"),
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            method=method,
        )
        try:
            with urlopen(request, timeout=30) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else {}
        except HTTPError as error:
            raw = error.read()
            return error.code, json.loads(raw) if raw else {}


class SubprocessGit:
    _SAFE_LOCAL_CONFIG = frozenset({
        "core.repositoryformatversion",
        "core.filemode",
        "core.bare",
        "core.logallrefupdates",
        "core.symlinks",
        "core.ignorecase",
        "remote.origin.url",
        "remote.origin.fetch",
    })

    def run(
        self,
        workspace: str,
        args: tuple[str, ...],
        environment: Mapping[str, str] | None = None,
    ) -> str:
        child = {
            "PATH": os.defpath,
            "LANG": "C.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_PROTOCOL_FROM_USER": "0",
        }
        if os.name == "nt" and "SYSTEMROOT" in os.environ:
            child["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        if environment:
            child.update(environment)
        try:
            return subprocess.check_output(
                [
                    "git", "-C", workspace,
                    "-c", f"core.hooksPath={os.devnull}",
                    "-c", "credential.helper=",
                    "-c", "core.fsmonitor=false",
                    *args,
                ],
                text=True, stderr=subprocess.PIPE, env=child,
            ).strip()
        except (OSError, subprocess.CalledProcessError) as error:
            raise PublicationConflict("trusted Git operation failed") from error

    def assert_safe_repository(self, workspace: str, expected_base_sha: str) -> None:
        root = Path(workspace).resolve()
        git_directory = root / ".git"
        if not git_directory.is_dir() or git_directory.is_symlink():
            raise PublicationConflict("publisher requires an isolated repository metadata directory")
        observed_root = Path(self.run(workspace, ("rev-parse", "--show-toplevel"))).resolve()
        if observed_root != root or self.run(workspace, ("rev-parse", "HEAD")) != expected_base_sha:
            raise PublicationConflict("publisher workspace is not at the authorized immutable base")
        raw_keys = self.run(workspace, ("config", "--local", "--null", "--name-only", "--list"))
        keys = {item.lower() for item in raw_keys.split("\0") if item}
        unsafe = sorted(
            key for key in keys
            if key not in self._SAFE_LOCAL_CONFIG
            and re.fullmatch(r"branch\.[^.]+\.(?:remote|merge)", key) is None
        )
        if unsafe:
            raise PublicationConflict(f"repository-controlled Git configuration is prohibited: {unsafe[0]}")
        hooks = git_directory / "hooks"
        if hooks.exists():
            for entry in hooks.iterdir():
                if entry.is_symlink() or (entry.is_file() and not entry.name.endswith(".sample")):
                    raise PublicationConflict("repository-controlled Git hooks are prohibited")


_METADATA_MARKER = "Sandiva-Exec-Metadata:"


def _encode_metadata(metadata: Mapping[str, Any]) -> str:
    raw = json.dumps(dict(metadata), sort_keys=True, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, str):
        raise PublicationConflict("publication metadata is missing")
    marker = next((line.split(":", 1)[1].strip() for line in value.splitlines() if line.startswith(_METADATA_MARKER)), None)
    if marker is None:
        raise PublicationConflict("publication metadata is missing")
    try:
        decoded = json.loads(base64.urlsafe_b64decode(marker.encode("ascii")))
    except (ValueError, json.JSONDecodeError) as error:
        raise PublicationConflict("publication metadata is malformed") from error
    if not isinstance(decoded, dict):
        raise PublicationConflict("publication metadata is malformed")
    return decoded


class GitHubPublisherGateway:
    """Concrete least-privilege task-branch/draft-PR GitHub implementation."""

    def __init__(
        self,
        repository: str,
        *,
        credential_provider: Callable[[], str],
        askpass_path: str,
        transport: GitHubTransport | None = None,
        git: SubprocessGit | None = None,
    ):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("GitHub repository identity is invalid")
        if not PurePosixPath(askpass_path).is_absolute() or ".." in PurePosixPath(askpass_path).parts:
            raise ValueError("GitHub askpass path must be absolute")
        self.repository = repository
        self._credential_provider = credential_provider
        self._askpass_path = askpass_path
        self._transport = transport or UrlLibGitHubTransport(repository, credential_provider)
        self._git = git or SubprocessGit()
        self._workspace: str | None = None
        self._branch: str | None = None

    def bind_workspace(self, workspace: str) -> None:
        value = Path(workspace)
        if not value.is_absolute() and not PurePosixPath(workspace).is_absolute():
            raise PublicationConflict("publisher workspace must be absolute")
        self._workspace = workspace

    def _require_workspace(self) -> str:
        if self._workspace is None:
            raise PublicationConflict("publisher workspace is not bound")
        return self._workspace

    def get_prepared_commit(self, pr_identity: str, expected_metadata: Mapping[str, Any]) -> str | None:
        workspace = self._require_workspace()
        try:
            message = self._git.run(workspace, ("log", "-1", "--format=%B"))
            metadata = _decode_metadata(message)
        except PublicationConflict:
            return None
        if metadata.get("prIdentity") != pr_identity:
            return None
        for field, expected in expected_metadata.items():
            if metadata.get(field) != expected:
                raise PublicationConflict("conflicting prepared commit ownership")
        commit_sha = self._git.run(workspace, ("rev-parse", "HEAD"))
        return commit_sha if re.fullmatch(r"[0-9a-f]{40}", commit_sha) else None

    def get_branch(self, branch: str) -> Mapping[str, Any] | None:
        self._branch = branch
        status, ref = self._transport.request("GET", f"/git/ref/heads/{quote(branch, safe='')}")
        if status == 404:
            return None
        if status != 200 or not isinstance(ref, dict):
            raise PublicationConflict(f"GitHub branch read failed with HTTP {status}")
        commit_sha = ref.get("object", {}).get("sha") if isinstance(ref.get("object"), dict) else None
        if not isinstance(commit_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
            raise PublicationConflict("GitHub branch readback has an invalid commit")
        commit_status, commit = self._transport.request("GET", f"/commits/{commit_sha}")
        if commit_status != 200 or not isinstance(commit, dict):
            raise PublicationConflict(f"GitHub commit read failed with HTTP {commit_status}")
        commit_data = commit.get("commit")
        metadata = _decode_metadata(commit_data.get("message") if isinstance(commit_data, dict) else None)
        return {"branch": branch, "commitSha": commit_sha, **metadata}

    def create_commit(self, workspace: str, branch: str, message: str, metadata: Mapping[str, Any]) -> str:
        if workspace != self._require_workspace() or branch == "main" or not branch.startswith("build/"):
            raise PublisherAuthorityDenied("publisher may create only the bound task branch")
        validator = getattr(self._git, "assert_safe_repository", None)
        if callable(validator):
            validator(workspace, str(metadata["baseSha"]))
        full_message = f"{message}\n\n{_METADATA_MARKER} {_encode_metadata(metadata)}"
        self._git.run(workspace, ("checkout", "-B", branch))
        self._git.run(workspace, ("add", "-A"))
        self._git.run(
            workspace,
            ("commit", "--no-verify", "-m", full_message),
            {"GIT_AUTHOR_NAME": "Sandiva Build Publisher", "GIT_AUTHOR_EMAIL": "build-publisher@sandiva.invalid",
             "GIT_COMMITTER_NAME": "Sandiva Build Publisher", "GIT_COMMITTER_EMAIL": "build-publisher@sandiva.invalid"},
        )
        commit_sha = self._git.run(workspace, ("rev-parse", "HEAD"))
        if not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
            raise PublicationConflict("local commit identity is invalid")
        return commit_sha

    def push_task_branch(self, branch: str, commit_sha: str, metadata: Mapping[str, Any]) -> None:
        if branch != self._branch or branch == "main" or metadata.get("prIdentity") is None:
            raise PublisherAuthorityDenied("publisher may push only the inspected task branch")
        token = self._credential_provider()
        if not token:
            raise PublicationConflict("GitHub publisher credential is unavailable")
        self._git.run(
            self._require_workspace(),
            (
                "push", "--no-verify", "--porcelain",
                f"--force-with-lease=refs/heads/{branch}:",
                f"https://github.com/{self.repository}.git", f"HEAD:refs/heads/{branch}",
            ),
            {"GIT_ASKPASS": self._askpass_path, "GIT_TERMINAL_PROMPT": "0", "SANDIVA_GITHUB_PUBLISHER_TOKEN": token},
        )
        observed = self.get_branch(branch)
        if observed is None or observed.get("commitSha") != commit_sha:
            raise PublicationConflict("GitHub branch readback does not match the immutable commit")
        for field, expected in metadata.items():
            if observed.get(field) != expected:
                raise PublicationConflict("GitHub branch readback provenance mismatch")

    def get_pull_request(self, pr_identity: str) -> Mapping[str, Any] | None:
        if self._branch is None:
            raise PublicationConflict("task branch is not bound")
        owner = self.repository.split("/", 1)[0]
        status, values = self._transport.request(
            "GET", f"/pulls?state=all&head={quote(owner + ':' + self._branch, safe=':')}"
        )
        if status != 200 or not isinstance(values, list):
            raise PublicationConflict(f"GitHub pull-request read failed with HTTP {status}")
        matches = []
        for item in values:
            if not isinstance(item, dict):
                continue
            try:
                metadata = _decode_metadata(item.get("body"))
            except PublicationConflict:
                continue
            if metadata.get("prIdentity") == pr_identity:
                matches.append((item, metadata))
        if not matches:
            return None
        if len(matches) != 1:
            raise PublicationConflict("conflicting duplicate pull requests")
        item, metadata = matches[0]
        return {
            "number": item.get("number"), "url": item.get("html_url"), "isDraft": item.get("draft"),
            "state": item.get("state"),
            "merged": item.get("merged", False),
            "head": item.get("head", {}).get("ref") if isinstance(item.get("head"), dict) else None,
            "base": item.get("base", {}).get("ref") if isinstance(item.get("base"), dict) else None,
            "body": item.get("body"), **metadata,
        }

    def create_draft_pull_request(
        self, branch: str, base: str, title: str, body: str, metadata: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        if branch != self._branch or base != "main":
            raise PublisherAuthorityDenied("publisher may create only a task draft PR to main")
        bound_body = f"{body}\n{_METADATA_MARKER} {_encode_metadata(metadata)}\n"
        status, _ = self._transport.request(
            "POST", "/pulls", {"title": title, "head": branch, "base": "main", "body": bound_body, "draft": True}
        )
        if status != 201:
            raise PublicationConflict(f"GitHub draft pull-request creation failed with HTTP {status}")
        observed = self.get_pull_request(str(metadata["prIdentity"]))
        if observed is None or observed.get("isDraft") is not True or observed.get("merged") is not False:
            raise PublicationConflict("GitHub draft pull-request readback failed")
        return observed


@dataclass(frozen=True)
class PublicationRecord:
    branch: str
    commit_sha: str
    draft_pr: Mapping[str, Any]
    pr_identity: str


def deterministic_branch(request: NormalizedExecutionRequest) -> str:
    task = re.sub(r"[^a-z0-9]+", "-", request.task_id.lower()).strip("-")
    if not task:
        raise PublicationConflict("task ID cannot form a branch identity")
    return f"build/{task[:80]}-{request.task_fingerprint[:12]}"


def deterministic_pr_identity(request: NormalizedExecutionRequest) -> str:
    return f"exec-pr:{request.task_id}:{request.task_version}:{request.task_fingerprint}"


class TrustedGitHubPublisher:
    """Publish only a task-bound branch and draft PR through a trusted gateway."""

    def __init__(self, gateway: GitHubGateway, authority: PublisherAuthority | None = None):
        self._gateway = gateway
        self._authority = authority or PublisherAuthority()

    @staticmethod
    def _assert_metadata(
        value: Mapping[str, Any], expected: Mapping[str, Any], kind: str
    ) -> None:
        for field in (
            "taskFingerprint", "baseSha", "patchDigest", "specificationHash",
            "acceptanceContractHash", "executorProfileFingerprint", "prIdentity", "attemptId",
        ):
            if value.get(field) != expected[field]:
                raise PublicationConflict(f"conflicting {kind} ownership")

    def publish_draft(
        self,
        request: NormalizedExecutionRequest,
        changes: ChangeSet,
        workspace: str,
        assert_current_authority: Callable[[], None],
    ) -> PublicationRecord:
        branch = deterministic_branch(request)
        pr_identity = deterministic_pr_identity(request)
        workspace_binder = getattr(self._gateway, "bind_workspace", None)
        if callable(workspace_binder):
            workspace_binder(workspace)
        metadata = {
            "taskFingerprint": request.task_fingerprint,
            "baseSha": request.base_sha,
            "patchDigest": changes.patch_digest,
            "attemptId": request.attempt_id,
            "prIdentity": pr_identity,
            "specificationHash": request.specification_hash,
            "acceptanceContractHash": request.acceptance_contract_hash,
            "executorProfileFingerprint": request.executor_profile_fingerprint,
        }

        assert_current_authority()
        self._authority.require("read_task_metadata")
        existing_branch = self._gateway.get_branch(branch)
        if existing_branch is not None:
            self._assert_metadata(existing_branch, metadata, "branch")
            commit_sha = existing_branch.get("commitSha")
            if not isinstance(commit_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
                raise PublicationConflict("conflicting branch commit identity")
        else:
            prepared_reader = getattr(self._gateway, "get_prepared_commit", None)
            commit_sha = prepared_reader(pr_identity, metadata) if callable(prepared_reader) else None
            if commit_sha is None:
                assert_current_authority()
                self._authority.require("create_task_commit")
                commit_sha = self._gateway.create_commit(
                    workspace,
                    branch,
                    f"EXEC-01: {request.task_id} implementation",
                    metadata,
                )
            if not isinstance(commit_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
                raise PublicationConflict("publisher returned an invalid commit identity")

            assert_current_authority()
            self._authority.require("push_task_branch")
            self._gateway.push_task_branch(branch, commit_sha, metadata)

        assert_current_authority()
        self._authority.require("read_task_metadata")
        existing_pr = self._gateway.get_pull_request(pr_identity)
        if existing_pr is not None:
            self._assert_metadata(existing_pr, metadata, "pull request")
            draft_pr = existing_pr
        else:
            assert_current_authority()
            self._authority.require("upsert_task_draft_pr")
            draft_pr = self._gateway.create_draft_pull_request(
                branch,
                "main",
                f"EXEC-01: {request.task_id}",
                (
                    f"Task: {request.task_id}\n"
                    f"Task fingerprint: {request.task_fingerprint}\n"
                    f"PM instruction: {request.originating_pm_instruction_ref} "
                    f"({request.originating_pm_instruction_fingerprint})\n"
                    f"Specification: {request.specification_ref} v{request.specification_version} "
                    f"({request.specification_hash})\n"
                    f"Acceptance contract: {request.acceptance_contract_ref} "
                    f"v{request.acceptance_contract_version} ({request.acceptance_contract_hash})\n"
                    f"Base: {request.base_sha}\n"
                    f"Attempt: {request.attempt_id}\n"
                    f"Executor profile: {request.executor_profile_id} "
                    f"({request.executor_profile_fingerprint})\n"
                ),
                metadata,
            )

        self._assert_metadata(draft_pr, metadata, "pull request")
        if (
            draft_pr.get("state") != "open"
            or draft_pr.get("merged", False) is not False
            or
            draft_pr.get("isDraft") is not True
            or draft_pr.get("head") != branch
            or draft_pr.get("base") != "main"
        ):
            raise PublicationConflict("pull request must be open, draft, unmerged, and task-bound")
        return PublicationRecord(
            branch=branch,
            commit_sha=commit_sha,
            draft_pr=dict(draft_pr),
            pr_identity=pr_identity,
        )
