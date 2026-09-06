from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol

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
            "acceptanceContractHash", "executorProfileFingerprint", "prIdentity",
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
            commit_sha = prepared_reader(pr_identity) if callable(prepared_reader) else None
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
            draft_pr.get("isDraft") is not True
            or draft_pr.get("head") != branch
            or draft_pr.get("base") != "main"
        ):
            raise PublicationConflict("pull request is not the expected task-bound draft")
        return PublicationRecord(
            branch=branch,
            commit_sha=commit_sha,
            draft_pr=dict(draft_pr),
            pr_identity=pr_identity,
        )
