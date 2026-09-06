from __future__ import annotations

import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from hermes_steward.prepublication import PrepublicationError, PrepublicationInspector
from test_execution_adapters import profile, request_for


def repository(directory: str):
    root = Path(directory, "repo")
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@sandiva.invalid"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Sandiva Test"], check=True)
    Path(root, "allowed").mkdir()
    Path(root, "allowed", "base.txt").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "-q", "-m", "base"], check=True)
    base = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    request = replace(
        request_for(profile("codex")), base_sha=base,
        permitted_repository_areas=("allowed/**",),
        prohibited_repository_areas=("prohibited/**", ".github/**"),
    )
    return root, request


class PrepublicationTests(unittest.TestCase):
    def test_complete_git_change_set_is_enumerated_and_digest_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            root, request = repository(directory)
            Path(root, "allowed", "base.txt").write_text("changed\n", encoding="utf-8")
            Path(root, "allowed", "new.txt").write_text("new\n", encoding="utf-8")
            inspector = PrepublicationInspector(max_file_bytes=1024, max_total_bytes=4096)
            first = inspector.inspect(root, request)
            second = inspector.inspect(root, request)
            self.assertEqual(first.changed_paths, ("allowed/base.txt", "allowed/new.txt"))
            self.assertEqual(first.patch_digest, second.patch_digest)
            self.assertEqual(len(first.patch_digest), 64)

    def test_prohibited_and_traversal_paths_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root, request = repository(directory)
            Path(root, "prohibited").mkdir()
            Path(root, "prohibited", "escape.txt").write_text("bad\n", encoding="utf-8")
            inspector = PrepublicationInspector()
            with self.assertRaisesRegex(PrepublicationError, "prohibited"):
                inspector.inspect(root, request)
            with self.assertRaisesRegex(PrepublicationError, "escapes root"):
                inspector.validate_paths(request, ["../outside.txt"])

    def test_git_symlink_escape_and_submodule_gitlink_fail_closed(self):
        for kind in ("symlink", "submodule"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root, request = repository(directory)
                if kind == "symlink":
                    blob = subprocess.check_output(
                        ["git", "-C", str(root), "hash-object", "-w", "--stdin"],
                        input="../../outside", text=True,
                    ).strip()
                    mode, sha, path = "120000", blob, "allowed/link"
                else:
                    sha = request.base_sha
                    mode, path = "160000", "allowed/submodule"
                subprocess.run(
                    ["git", "-C", str(root), "update-index", "--add", "--cacheinfo", f"{mode},{sha},{path}"],
                    check=True,
                )
                with self.assertRaisesRegex(PrepublicationError, "symlink escape" if kind == "symlink" else "submodule"):
                    PrepublicationInspector().inspect(root, request)

    def test_secret_binary_generated_and_oversized_material_fail_closed(self):
        fixtures = {
            "private-key": (
                "allowed/signing.pem",
                b"-----BEGIN " + b"PRIVATE KEY-----\nSENTINEL\n",
            ),
            "binary": ("allowed/blob.bin", b"\x00\x01\x02"),
            "generated": ("allowed/app.min.js", b"minified"),
            "oversized": ("allowed/large.txt", b"x" * 65),
        }
        expected = {
            "private-key": "secret or private-key", "binary": "binary artifact",
            "generated": "generated artifact", "oversized": "file size limit",
        }
        for name, (relative, content) in fixtures.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root, request = repository(directory)
                target = Path(root, relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                with self.assertRaisesRegex(PrepublicationError, expected[name]):
                    PrepublicationInspector(max_file_bytes=64, max_total_bytes=128).inspect(root, request)

    def test_workspace_must_be_a_cleanly_bounded_git_root_at_the_authorized_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root, request = repository(directory)
            wrong = replace(request, base_sha="0" * 40)
            with self.assertRaisesRegex(PrepublicationError, "authorized base"):
                PrepublicationInspector().inspect(root, wrong)
            with self.assertRaisesRegex(PrepublicationError, "Git workspace"):
                PrepublicationInspector().inspect(Path(directory), request)


if __name__ == "__main__":
    unittest.main()
