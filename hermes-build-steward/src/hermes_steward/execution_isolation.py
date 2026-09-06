from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Mapping, Sequence

from .execution_contracts import ExecutorProfile, NormalizedExecutionRequest


class WorkspaceError(RuntimeError):
    pass


class NetworkPolicyDenied(PermissionError):
    pass


def _endpoint_parts(endpoint: str) -> tuple[str, int]:
    if not isinstance(endpoint, str) or not re.fullmatch(r"[A-Za-z0-9.-]+:[1-9][0-9]{0,4}", endpoint):
        raise NetworkPolicyDenied("network endpoint must be an exact host:port pair")
    host, raw_port = endpoint.lower().rsplit(":", 1)
    port = int(raw_port)
    if port > 65535:
        raise NetworkPolicyDenied("network endpoint port is invalid")
    return host, port


def _intrinsically_denied_endpoint(endpoint: str) -> bool:
    host, _ = _endpoint_parts(endpoint)
    if host == "graph.microsoft.com" or host.endswith(".sharepoint.com") or "browser" in host:
        return True
    if host in {"localhost", "metadata.google.internal"}:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_private or address.is_loopback or address.is_link_local or address.is_multicast


@dataclass(frozen=True)
class ContainmentPolicy:
    cpu_limit: str
    memory_limit: str
    pids_limit: int
    workspace_limit_bytes: int
    wall_time_seconds: int
    output_limit_bytes: int
    network_name: str
    allowed_endpoints: tuple[str, ...]

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", self.cpu_limit) or float(self.cpu_limit) <= 0:
            raise ValueError("CPU limit must be positive")
        if not re.fullmatch(r"[1-9][0-9]*(?:[kmg])", self.memory_limit.lower()):
            raise ValueError("memory limit must be an explicit bounded size")
        if any(not isinstance(value, int) or isinstance(value, bool) or value < 1 for value in (
            self.pids_limit, self.workspace_limit_bytes, self.wall_time_seconds, self.output_limit_bytes
        )):
            raise ValueError("execution resource bounds must be positive integers")
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,63}", self.network_name):
            raise ValueError("network_name must identify a dedicated egress network")
        if self.network_name in {"host", "bridge", "none", "default"}:
            raise ValueError("executor requires a dedicated filtered egress network")
        if not self.allowed_endpoints or len(self.allowed_endpoints) != len(set(self.allowed_endpoints)):
            raise ValueError("allowed_endpoints must be non-empty and unique")
        for endpoint in self.allowed_endpoints:
            _endpoint_parts(endpoint)
            if _intrinsically_denied_endpoint(endpoint):
                raise ValueError(f"prohibited endpoint cannot be allowlisted: {endpoint}")

    def authorize_endpoint(self, endpoint: str) -> str:
        normalized = endpoint.lower()
        if _intrinsically_denied_endpoint(normalized) or normalized not in {
            item.lower() for item in self.allowed_endpoints
        }:
            raise NetworkPolicyDenied(f"network endpoint denied: {endpoint}")
        return normalized


def sanitized_executor_environment(
    host_environment: Mapping[str, str],
    request: NormalizedExecutionRequest,
    policy: ContainmentPolicy,
) -> dict[str, str]:
    """Build an empty-by-default environment; parent secrets are intentionally ignored."""
    del host_environment
    if request.executor_profile_id == "" or request.attempt_id == "":
        raise ValueError("execution identity is required")
    return {
        "EXEC_TASK_ID": request.task_id,
        "EXEC_TASK_FINGERPRINT": request.task_fingerprint,
        "EXEC_ATTEMPT_ID": request.attempt_id,
        "EXEC_PROFILE_ID": request.executor_profile_id,
        "EXEC_ALLOWED_ENDPOINTS": json.dumps(sorted(policy.allowed_endpoints), separators=(",", ":")),
        "CI": "true",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }


def _absolute_posix(path: str, field: str) -> str:
    value = PurePosixPath(path)
    if not value.is_absolute() or ".." in value.parts or "\\" in path:
        raise ValueError(f"{field} must be an absolute normalized Linux path")
    return value.as_posix()


def build_executor_container_command(
    profile: ExecutorProfile,
    policy: ContainmentPolicy,
    request: NormalizedExecutionRequest,
    workspace: str,
    sealed_request_file: str,
) -> list[str]:
    if profile.profile_id != request.executor_profile_id or profile.fingerprint != request.executor_profile_fingerprint:
        raise ValueError("profile does not match normalized request")
    if profile.credential_mode != "trusted-egress-gateway":
        raise ValueError("raw provider credentials are prohibited")
    if set(profile.allowed_endpoints) != set(policy.allowed_endpoints):
        raise ValueError("profile and containment network policies must match exactly")
    workspace_path = _absolute_posix(workspace, "workspace")
    request_path = _absolute_posix(sealed_request_file, "sealed_request_file")
    return [
        "docker", "run", "--rm", "--init", "--network", policy.network_name,
        "--cpus", policy.cpu_limit, "--memory", policy.memory_limit,
        "--pids-limit", str(policy.pids_limit), "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "65532:65532",
        "--storage-opt", f"size={policy.workspace_limit_bytes}",
        "--mount", f"type=bind,src={workspace_path},dst=/workspace,rw",
        "--mount", f"type=bind,src={request_path},dst=/run/exec/request.json,readonly",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--env", f"EXECUTOR_GATEWAY_ENDPOINT={profile.gateway_endpoint}",
        "--label", f"sandiva.exec.task={request.task_id}",
        "--label", f"sandiva.exec.attempt={request.attempt_id}",
        profile.image,
        *profile.fixed_argv,
    ]


@dataclass(frozen=True)
class BoundedExecutionResult:
    return_code: int | None
    stdout: bytes
    stderr: bytes
    termination_reason: str | None
    elapsed_seconds: float
    process_tree_terminated: bool


class BoundedExecutionRunner:
    def __init__(self, policy: ContainmentPolicy):
        self.policy = policy

    @staticmethod
    def _child_environment(approved: Mapping[str, str]) -> dict[str, str]:
        environment = dict(approved)
        environment.setdefault("PATH", os.defpath)
        environment.setdefault("LANG", "C.UTF-8")
        if os.name == "nt" and "SYSTEMROOT" in os.environ:
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        return environment

    @staticmethod
    def _terminate_tree(process: subprocess.Popen[bytes]) -> bool:
        if process.poll() is not None:
            return True
        if os.name == "nt":
            environment = {"PATH": os.defpath}
            if "SYSTEMROOT" in os.environ:
                environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
            completed = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment, check=False,
            )
            if completed.returncode != 0 and process.poll() is None:
                process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        return process.poll() is not None

    def run_raw(self, command: Sequence[str], approved_environment: Mapping[str, str]) -> BoundedExecutionResult:
        if not command or any(not isinstance(item, str) or not item for item in command):
            raise ValueError("command must be a non-empty argument vector")
        popen_options: dict[str, object] = {}
        if os.name == "nt":
            popen_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_options["start_new_session"] = True
        started = time.monotonic()
        process = subprocess.Popen(
            list(command), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=self._child_environment(approved_environment), **popen_options,
        )
        captured = {"stdout": bytearray(), "stderr": bytearray()}
        total = 0
        lock = threading.Lock()
        output_exceeded = threading.Event()

        def drain(name: str, stream) -> None:
            nonlocal total
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                with lock:
                    remaining = max(0, self.policy.output_limit_bytes - total)
                    captured[name].extend(chunk[:remaining])
                    total += min(len(chunk), remaining)
                    if len(chunk) > remaining:
                        output_exceeded.set()

        threads = [
            threading.Thread(target=drain, args=("stdout", process.stdout), daemon=True),
            threading.Thread(target=drain, args=("stderr", process.stderr), daemon=True),
        ]
        for thread in threads:
            thread.start()
        reason = None
        tree_terminated = False
        while process.poll() is None:
            if output_exceeded.is_set():
                reason = "OUTPUT_LIMIT"
                tree_terminated = self._terminate_tree(process)
                break
            if time.monotonic() - started >= self.policy.wall_time_seconds:
                reason = "TIME_LIMIT"
                tree_terminated = self._terminate_tree(process)
                break
            time.sleep(0.01)
        if process.poll() is None:
            tree_terminated = self._terminate_tree(process)
        process.wait()
        for thread in threads:
            thread.join(timeout=2)
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()
        if output_exceeded.is_set() and reason is None:
            reason = "OUTPUT_LIMIT"
        if reason is None or (not tree_terminated and process.poll() is not None):
            tree_terminated = True
        return BoundedExecutionResult(
            return_code=process.returncode, stdout=bytes(captured["stdout"]),
            stderr=bytes(captured["stderr"]), termination_reason=reason,
            elapsed_seconds=time.monotonic() - started, process_tree_terminated=tree_terminated,
        )


@dataclass(frozen=True)
class ExecutionWorkspace:
    path: Path
    identity: str
    base_sha: str


class WorkspaceFactory:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def create(self, request: NormalizedExecutionRequest, source_repository: Path) -> ExecutionWorkspace:
        identity = f"{request.task_id}-{request.task_fingerprint[:12]}-{request.attempt_id}"
        safe_identity = re.sub(r"[^A-Za-z0-9._-]", "-", identity)
        target = (self.root / safe_identity).resolve()
        if target.parent != self.root:
            raise WorkspaceError("workspace identity escapes configured root")
        if target.exists():
            raise WorkspaceError("task-bound execution workspace already exists")
        source = source_repository.resolve()
        try:
            subprocess.run(
                ["git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", str(source), str(target)],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            subprocess.run(
                ["git", "-C", str(target), "checkout", "--quiet", "--detach", request.base_sha],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            observed = subprocess.check_output(["git", "-C", str(target), "rev-parse", "HEAD"], text=True).strip()
            if observed != request.base_sha:
                raise WorkspaceError("workspace HEAD does not match immutable base SHA")
        except Exception as error:
            if target.exists() and target.parent == self.root:
                shutil.rmtree(target, ignore_errors=True)
            if isinstance(error, WorkspaceError):
                raise
            raise WorkspaceError("failed to create exact-base isolated workspace") from error
        return ExecutionWorkspace(path=target, identity=safe_identity, base_sha=request.base_sha)


class ContainerProviderRunner:
    """Run a fixed provider launcher in the bounded container and parse its JSON envelope."""

    def __init__(
        self,
        policy: ContainmentPolicy,
        sealed_request_root: Path,
        *,
        runner: BoundedExecutionRunner | None = None,
    ):
        self.policy = policy
        self.sealed_request_root = sealed_request_root.resolve()
        self.sealed_request_root.mkdir(parents=True, exist_ok=True)
        self.runner = runner or BoundedExecutionRunner(policy)

    def invoke(
        self,
        profile: ExecutorProfile,
        request: NormalizedExecutionRequest,
        workspace: str,
    ) -> Mapping[str, object]:
        safe_identity = re.sub(r"[^A-Za-z0-9._-]", "-", f"{request.task_id}-{request.attempt_id}")
        sealed = (self.sealed_request_root / f"{safe_identity}.json").resolve()
        if sealed.parent != self.sealed_request_root or sealed.exists():
            raise WorkspaceError("sealed request identity is unsafe or already exists")
        payload = json.dumps(request.as_dict(), sort_keys=True, separators=(",", ":"))
        try:
            sealed.write_text(payload, encoding="utf-8")
            try:
                sealed.chmod(0o400)
            except OSError:
                pass
            command = build_executor_container_command(
                profile, self.policy, request, workspace, sealed.as_posix()
            )
            environment = sanitized_executor_environment(os.environ, request, self.policy)
            outcome = self.runner.run_raw(command, environment)
            if outcome.termination_reason is not None:
                if profile.provider == "codex":
                    return {
                        "status": "timed_out", "started_at": "1970-01-01T00:00:00Z",
                        "completed_at": "1970-01-01T00:00:00Z", "commands": [], "tests": [],
                        "changed_paths": [], "patch_digest": None, "log_refs": [], "error_type": "timeout",
                    }
                return {
                    "stop_reason": "timeout", "startedAt": "1970-01-01T00:00:00Z",
                    "completedAt": "1970-01-01T00:00:00Z", "commandsExecuted": [], "testOutcomes": [],
                    "changedPaths": [], "patchDigest": None, "evidenceReferences": [], "errorType": "timeout",
                }
            try:
                raw = json.loads(outcome.stdout.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise WorkspaceError("provider launcher returned malformed JSON") from error
            if not isinstance(raw, dict):
                raise WorkspaceError("provider launcher result must be a JSON object")
            return raw
        finally:
            if sealed.exists():
                try:
                    sealed.chmod(0o600)
                except OSError:
                    pass
                sealed.unlink()
