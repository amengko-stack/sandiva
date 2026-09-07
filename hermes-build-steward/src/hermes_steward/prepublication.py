from __future__ import annotations

import hashlib
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable, Sequence

from .contracts import ContractValidationError, canonical_json, validate_repository_paths
from .execution_contracts import NormalizedExecutionRequest


class PrepublicationError(RuntimeError):
    pass


_KEY_SUFFIXES = {
    ".pem", ".pfx", ".p12", ".key", ".keystore", ".jks", ".kdbx",
}
_GENERATED_SUFFIXES = (".min.js", ".min.css", ".map", ".pyc", ".pyo")
_GENERATED_PARTS = {"node_modules", ".next", "dist", "coverage", "__pycache__"}
_SECRET_PATTERNS = (
    re.compile(br"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(br"(?:ghp|github_pat|sk-ant|sk-proj)-[A-Za-z0-9_-]{8,}"),
    re.compile(br"AKIA[0-9A-Z]{16}"),
)


@dataclass(frozen=True)
class ChangeSet:
    changed_paths: tuple[str, ...]
    patch_digest: str
    total_bytes: int
    binary_paths: tuple[str, ...]
    generated_paths: tuple[str, ...]


class PrepublicationInspector:
    def __init__(self, *, max_file_bytes: int = 16 * 1024 * 1024, max_total_bytes: int = 64 * 1024 * 1024):
        if max_file_bytes < 1 or max_total_bytes < max_file_bytes:
            raise ValueError("pre-publication size limits are invalid")
        self.max_file_bytes = max_file_bytes
        self.max_total_bytes = max_total_bytes

    @staticmethod
    def _git(root: Path, *args: str, text: bool = False) -> bytes | str:
        environment = {
            "PATH": os.defpath,
            "LANG": "C.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_PROTOCOL_FROM_USER": "0",
        }
        if os.name == "nt" and "SYSTEMROOT" in os.environ:
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        try:
            return subprocess.check_output(
                [
                    "git", "-C", str(root),
                    "-c", f"core.hooksPath={os.devnull}",
                    "-c", "credential.helper=",
                    "-c", "core.fsmonitor=false",
                    *args,
                ],
                stderr=subprocess.PIPE, text=text, env=environment,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise PrepublicationError("workspace is not an inspectable Git workspace") from error

    def validate_paths(self, request: NormalizedExecutionRequest, paths: Sequence[str]) -> None:
        task_projection = {
            "permittedRepositoryAreas": list(request.permitted_repository_areas),
            "prohibitedRepositoryAreas": list(request.prohibited_repository_areas),
        }
        try:
            validate_repository_paths(task_projection, paths)
        except ContractValidationError as error:
            raise PrepublicationError(str(error)) from error

    def _workspace_root(self, workspace: Path, request: NormalizedExecutionRequest) -> Path:
        root = workspace.resolve()
        observed_root = Path(str(self._git(root, "rev-parse", "--show-toplevel", text=True)).strip()).resolve()
        if observed_root != root:
            raise PrepublicationError("workspace must be the exact Git workspace root")
        observed_head = str(self._git(root, "rev-parse", "HEAD", text=True)).strip()
        if observed_head != request.base_sha:
            raise PrepublicationError("workspace HEAD does not match the authorized base")
        return root

    def _changed_paths(self, root: Path, base_sha: str) -> tuple[str, ...]:
        tracked = bytes(self._git(root, "diff", "--name-only", "--no-renames", "-z", base_sha, "--"))
        staged = bytes(self._git(root, "diff", "--cached", "--name-only", "--no-renames", "-z", base_sha, "--"))
        untracked = bytes(self._git(root, "ls-files", "--others", "--exclude-standard", "-z"))
        paths = {
            item.decode("utf-8")
            for payload in (tracked, staged, untracked)
            for item in payload.split(b"\0")
            if item
        }
        return tuple(sorted(paths))

    def _index_modes(self, root: Path) -> dict[str, str]:
        payload = bytes(self._git(root, "ls-files", "--stage", "-z"))
        modes: dict[str, str] = {}
        for item in payload.split(b"\0"):
            if not item:
                continue
            metadata, raw_path = item.split(b"\t", 1)
            mode = metadata.split(b" ", 1)[0].decode("ascii")
            modes[raw_path.decode("utf-8")] = mode
        return modes

    @staticmethod
    def _is_generated(path: str) -> bool:
        normalized = PurePosixPath(path)
        return any(part in _GENERATED_PARTS for part in normalized.parts) or path.endswith(_GENERATED_SUFFIXES)

    @staticmethod
    def _contains_secret(path: str, content: bytes) -> bool:
        suffix = Path(path).suffix.lower()
        return suffix in _KEY_SUFFIXES or any(pattern.search(content) for pattern in _SECRET_PATTERNS)

    def _symlink_target(self, root: Path, path: str) -> str:
        try:
            return str(self._git(root, "show", f":{path}", text=True)).strip()
        except PrepublicationError as error:
            raise PrepublicationError(f"symlink escape cannot be safely inspected: {path}") from error

    @staticmethod
    def _symlink_escapes(root: Path, path: str, target: str) -> bool:
        if not target or PurePosixPath(target).is_absolute() or "\\" in target:
            return True
        resolved = (root / PurePosixPath(path).parent / PurePosixPath(target)).resolve()
        try:
            resolved.relative_to(root)
        except ValueError:
            return True
        return False

    def inspect(self, workspace: Path | str, request: NormalizedExecutionRequest) -> ChangeSet:
        root = self._workspace_root(Path(workspace), request)
        changed_paths = self._changed_paths(root, request.base_sha)
        self.validate_paths(request, changed_paths)
        modes = self._index_modes(root)
        entries: list[dict[str, object]] = []
        binary_paths: list[str] = []
        generated_paths: list[str] = []
        total = 0
        for path in changed_paths:
            if path == ".gitmodules" or modes.get(path) == "160000":
                raise PrepublicationError(f"submodule mutation or escape is prohibited: {path}")
            if modes.get(path) == "120000":
                target = self._symlink_target(root, path)
                if self._symlink_escapes(root, path, target):
                    raise PrepublicationError(f"symlink escape is prohibited: {path}")
            candidate = root / PurePosixPath(path)
            if candidate.is_symlink():
                try:
                    candidate.resolve().relative_to(root)
                except (OSError, ValueError) as error:
                    raise PrepublicationError(f"symlink escape is prohibited: {path}") from error
            if not candidate.exists() and not candidate.is_symlink():
                entries.append({"path": path, "kind": "deleted", "sha256": None, "size": 0})
                continue
            if candidate.is_dir():
                raise PrepublicationError(f"changed path is not a regular file: {path}")
            if candidate.is_symlink():
                content = os.readlink(candidate).encode("utf-8")
                kind = "symlink"
            else:
                content = candidate.read_bytes()
                kind = "file"
            if len(content) > self.max_file_bytes:
                raise PrepublicationError(f"changed file exceeds file size limit: {path}")
            total += len(content)
            if total > self.max_total_bytes:
                raise PrepublicationError("complete change set exceeds total size limit")
            if self._contains_secret(path, content):
                raise PrepublicationError(f"unauthorized secret or private-key material: {path}")
            generated = self._is_generated(path)
            if generated:
                generated_paths.append(path)
                raise PrepublicationError(f"unexpected generated artifact is prohibited: {path}")
            try:
                content.decode("utf-8")
                binary = b"\0" in content
            except UnicodeDecodeError:
                binary = True
            if binary:
                binary_paths.append(path)
                raise PrepublicationError(f"unexpected binary artifact is prohibited: {path}")
            entries.append({
                "path": path, "kind": kind, "sha256": hashlib.sha256(content).hexdigest(),
                "size": len(content),
            })
        patch_digest = hashlib.sha256(canonical_json(entries)).hexdigest()
        return ChangeSet(
            changed_paths=changed_paths, patch_digest=patch_digest, total_bytes=total,
            binary_paths=tuple(binary_paths), generated_paths=tuple(generated_paths),
        )
