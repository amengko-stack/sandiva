from __future__ import annotations

import ipaddress
import base64
import json
import os
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping, Sequence

from .execution_contracts import ExecutorProfile, NormalizedExecutionRequest
from .contracts import fingerprint


class WorkspaceError(RuntimeError):
    pass


class NetworkPolicyDenied(PermissionError):
    pass


@dataclass(frozen=True)
class GatewayNetworkBinding:
    network_name: str
    container_name: str
    image: str
    policy_fingerprint: str

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", self.container_name):
            raise ValueError("gateway container name is invalid")
        if not re.fullmatch(r"(?:[a-z0-9][a-z0-9._/:~-]*@)?sha256:[0-9a-f]{64}", self.image):
            raise ValueError("gateway image must be digest pinned")
        if not re.fullmatch(r"[0-9a-f]{64}", self.policy_fingerprint):
            raise ValueError("gateway policy fingerprint is invalid")


class DockerNetworkAttestor:
    """Fail closed unless Docker exposes one exact gateway on an internal network."""

    def __init__(
        self,
        binding: GatewayNetworkBinding,
        *,
        inspect: Callable[[str, str], Mapping[str, object]] | None = None,
    ):
        self.binding = binding
        self._inspect_override = inspect

    @staticmethod
    def _docker_inspect(kind: str, name: str) -> Mapping[str, object]:
        target = ["docker", "network", "inspect", name] if kind == "network" else ["docker", "inspect", name]
        try:
            raw = subprocess.check_output(
                target, stderr=subprocess.PIPE,
                env=BoundedExecutionRunner._child_environment({}),
            )
            value = json.loads(raw)
        except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
            raise NetworkPolicyDenied(f"Docker {kind} attestation is unavailable") from error
        if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
            raise NetworkPolicyDenied(f"Docker {kind} attestation is malformed")
        return value[0]

    def _inspect(self, kind: str, name: str) -> Mapping[str, object]:
        return self._inspect_override(kind, name) if self._inspect_override is not None else self._docker_inspect(kind, name)

    def attest(self, profile: ExecutorProfile, policy: ContainmentPolicy) -> None:
        binding = self.binding
        if binding.network_name != policy.network_name or binding.policy_fingerprint != policy.network_policy_fingerprint:
            raise NetworkPolicyDenied("gateway binding does not match the execution network")
        network = self._inspect("network", binding.network_name)
        containers = network.get("Containers")
        if network.get("Name") != binding.network_name or network.get("Internal") is not True or not isinstance(containers, dict):
            raise NetworkPolicyDenied("executor network is not an attested internal network")
        names = {item.get("Name") for item in containers.values() if isinstance(item, dict)}
        if names != {binding.container_name}:
            raise NetworkPolicyDenied("executor network has a missing or unexpected peer")
        gateway = self._inspect("container", binding.container_name)
        config = gateway.get("Config")
        settings = gateway.get("NetworkSettings")
        if not isinstance(config, dict) or not isinstance(settings, dict):
            raise NetworkPolicyDenied("gateway container attestation is malformed")
        labels = config.get("Labels")
        networks = settings.get("Networks")
        if (
            gateway.get("Name") != f"/{binding.container_name}"
            or config.get("Image") != binding.image
            or not isinstance(labels, dict)
            or labels.get("sandiva.exec.gateway-policy") != binding.policy_fingerprint
            or not isinstance(networks, dict)
            or binding.network_name not in networks
            or profile.gateway_endpoint not in profile.allowed_endpoints
        ):
            raise NetworkPolicyDenied("gateway identity or policy attestation mismatch")


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
        memory_value = int(self.memory_limit[:-1]) * {"k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}[self.memory_limit[-1].lower()]
        if self.workspace_limit_bytes > memory_value // 2:
            raise ValueError("tmpfs workspace limit must leave at least half the container memory headroom")
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

    @property
    def network_policy_fingerprint(self) -> str:
        return fingerprint({
            "networkName": self.network_name,
            "allowedEndpoints": sorted(self.allowed_endpoints),
            "topology": "internal-network-single-attested-gateway-v1",
        })


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
        "EXEC_PROFILE_FINGERPRINT": request.executor_profile_fingerprint,
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
    container_name: str,
) -> list[str]:
    if profile.profile_id != request.executor_profile_id or profile.fingerprint != request.executor_profile_fingerprint:
        raise ValueError("profile does not match normalized request")
    if profile.credential_mode != "trusted-egress-gateway":
        raise ValueError("raw provider credentials are prohibited")
    if set(profile.allowed_endpoints) != set(policy.allowed_endpoints):
        raise ValueError("profile and containment network policies must match exactly")
    _absolute_posix(workspace, "workspace")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", container_name):
        raise ValueError("container_name is invalid")
    request_payload = base64.b64encode(
        json.dumps(request.as_dict(), sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    return [
        "docker", "create", "--name", container_name, "--init", "--network", policy.network_name,
        "--cpus", policy.cpu_limit, "--memory", policy.memory_limit,
        "--memory-swap", policy.memory_limit, "--pids-limit", str(policy.pids_limit),
        "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "65532:65532",
        "--tmpfs", (
            "/workspace:rw,nosuid,nodev,noexec,"
            f"size={policy.workspace_limit_bytes},uid=65532,gid=65532,mode=0700"
        ),
        "--tmpfs", "/run/exec:rw,nosuid,nodev,noexec,size=1048576,uid=65532,gid=65532,mode=0700",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--workdir", "/workspace",
        "--env", f"EXEC_REQUEST_B64={request_payload}",
        "--env", f"EXEC_WORKSPACE_LIMIT_BYTES={policy.workspace_limit_bytes}",
        "--env", f"EXECUTOR_GATEWAY_ENDPOINT={profile.gateway_endpoint}",
        "--label", f"sandiva.exec.task={request.task_id}",
        "--label", f"sandiva.exec.attempt={request.attempt_id}",
        profile.image,
        "sleep", "infinity",
    ]


def execution_container_name(request: NormalizedExecutionRequest) -> str:
    return re.sub(
        r"[^A-Za-z0-9_.-]", "-", f"exec01-{request.task_id}-{request.attempt_id}"
    )[:128]


class DockerContainerJobRunner:
    """Use a bounded tmpfs workspace and copy results out before container destruction."""

    def __init__(
        self,
        policy: ContainmentPolicy,
        *,
        runner: BoundedExecutionRunner | None = None,
        network_attestor: DockerNetworkAttestor | None = None,
    ):
        self.policy = policy
        self.runner = runner or BoundedExecutionRunner(policy)
        self.network_attestor = network_attestor

    _RUNTIME_WRAPPER = "/opt/sandiva/bin/exec01-runtime"

    def _remove_container(self, container_name: str) -> None:
        try:
            completed = subprocess.run(
                ["docker", "rm", "-f", container_name], check=False,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=min(self.policy.wall_time_seconds, 30),
                env=BoundedExecutionRunner._child_environment({}),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise WorkspaceError("container cleanup failed") from error
        if completed.returncode != 0 and b"No such container" not in completed.stderr:
            raise WorkspaceError("container cleanup failed")

    def cancel(self, request: NormalizedExecutionRequest) -> None:
        """Force-remove the task-bound container, terminating every descendant."""
        self._remove_container(execution_container_name(request))

    def _checked(self, command: Sequence[str]) -> None:
        try:
            subprocess.run(
                list(command), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=self.policy.wall_time_seconds,
                env=BoundedExecutionRunner._child_environment({}),
            )
        except subprocess.TimeoutExpired as error:
            raise WorkspaceError("container lifecycle operation exceeded its time bound") from error
        except (OSError, subprocess.CalledProcessError) as error:
            raise WorkspaceError("container lifecycle operation failed") from error

    def _stream_workspace(self, container_name: str, workspace: str) -> None:
        source = Path(workspace)
        with tempfile.SpooledTemporaryFile(
            max_size=min(self.policy.workspace_limit_bytes, 8 * 1024 * 1024),
            dir=str(source.parent),
        ) as archive_file:
            with tarfile.open(fileobj=archive_file, mode="w|") as archive:
                archive.add(source, arcname=".", recursive=True)
            archive_size = archive_file.tell()
            if archive_size > self.policy.workspace_limit_bytes + 8 * 1024 * 1024:
                raise WorkspaceError("trusted workspace seed exceeds the configured quota")
            archive_file.seek(0)
            process = subprocess.Popen(
                [
                    "docker", "exec", "-i", "--user", "65532:65532", container_name,
                    self._RUNTIME_WRAPPER, "import",
                ],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=BoundedExecutionRunner._child_environment({}),
            )
            assert process.stdin is not None
            try:
                shutil.copyfileobj(archive_file, process.stdin, length=1024 * 1024)
                process.stdin.close()
                process.wait(timeout=self.policy.wall_time_seconds)
            except BaseException:
                process.kill()
                process.wait(timeout=5)
                raise
            stdout = process.stdout.read(self.policy.output_limit_bytes) if process.stdout is not None else b""
            stderr = process.stderr.read(self.policy.output_limit_bytes) if process.stderr is not None else b""
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
            if process.returncode != 0:
                raise WorkspaceError(f"container workspace import failed: {(stdout + stderr)[:256]!r}")

    def _extract_workspace_archive(self, archive_file, staging: Path) -> None:
        total_size = 0
        entry_count = 0
        observed: set[str] = set()
        with tarfile.open(fileobj=archive_file, mode="r|*") as archive:
            for member in archive:
                entry_count += 1
                if entry_count > 100_000:
                    raise WorkspaceError("container workspace export has too many entries")
                parts = PurePosixPath(member.name).parts
                if not parts:
                    continue
                if PurePosixPath(member.name).is_absolute() or ".." in parts or "\\" in member.name:
                    raise WorkspaceError("container workspace export contains an unsafe path")
                normalized = "/".join(parts)
                if normalized in observed:
                    raise WorkspaceError("container workspace export contains a duplicate path")
                observed.add(normalized)
                target = staging.joinpath(*parts)
                parent = staging
                for part in parts[:-1]:
                    parent = parent / part
                    if os.path.lexists(parent):
                        if parent.is_symlink() or not parent.is_dir():
                            raise WorkspaceError("container workspace export traverses a non-directory")
                    else:
                        parent.mkdir(mode=0o700)
                if member.isdir():
                    if os.path.lexists(target):
                        if target.is_symlink() or not target.is_dir():
                            raise WorkspaceError("container workspace export has a conflicting directory")
                    else:
                        target.mkdir(mode=0o700)
                    continue
                if os.path.lexists(target):
                    raise WorkspaceError("container workspace export contains a duplicate target")
                if member.issym():
                    link = PurePosixPath(member.linkname)
                    if (
                        "\x00" in member.linkname
                        or link.is_absolute()
                        or ".." in link.parts
                        or "\\" in member.linkname
                    ):
                        raise WorkspaceError("container workspace export contains an invalid symlink")
                    target.symlink_to(member.linkname)
                    continue
                if not member.isreg():
                    raise WorkspaceError("container workspace export contains an unsupported entry")
                total_size += member.size
                if total_size > self.policy.workspace_limit_bytes:
                    raise WorkspaceError("container workspace export exceeds the configured quota")
                source = archive.extractfile(member)
                if source is None:
                    raise WorkspaceError("container workspace export file is unreadable")
                with source, target.open("xb") as destination:
                    shutil.copyfileobj(source, destination, length=1024 * 1024)
                target.chmod(member.mode & 0o777)

    def _export_workspace(self, container_name: str, staging: Path) -> None:
        with tempfile.SpooledTemporaryFile(
            max_size=min(self.policy.workspace_limit_bytes, 8 * 1024 * 1024),
            dir=str(staging.parent),
        ) as archive_file, tempfile.SpooledTemporaryFile(
            max_size=self.policy.output_limit_bytes,
            dir=str(staging.parent),
        ) as error_file:
            try:
                completed = subprocess.run(
                    [
                        "docker", "exec", "--user", "65532:65532", container_name,
                        self._RUNTIME_WRAPPER, "export",
                    ],
                    check=False, stdout=archive_file, stderr=error_file,
                    timeout=self.policy.wall_time_seconds,
                    env=BoundedExecutionRunner._child_environment({}),
                )
            except subprocess.TimeoutExpired as error:
                raise WorkspaceError("container workspace export exceeded its time bound") from error
            except OSError as error:
                raise WorkspaceError("container workspace export failed") from error
            if completed.returncode != 0:
                error_file.seek(0)
                raise WorkspaceError(f"container workspace export failed: {error_file.read(256)!r}")
            if archive_file.tell() > self.policy.workspace_limit_bytes * 2 + 8 * 1024 * 1024:
                raise WorkspaceError("container workspace archive exceeds its transport bound")
            archive_file.seek(0)
            self._extract_workspace_archive(archive_file, staging)

    def run_container(
        self,
        profile: ExecutorProfile,
        policy: ContainmentPolicy,
        request: NormalizedExecutionRequest,
        workspace: str,
        environment: Mapping[str, str],
    ) -> BoundedExecutionResult:
        if policy != self.policy:
            raise WorkspaceError("container runner policy mismatch")
        if self.network_attestor is None:
            raise NetworkPolicyDenied("executor network attestation is required")
        self.network_attestor.attest(profile, policy)
        safe = execution_container_name(request)
        create_command = build_executor_container_command(profile, policy, request, workspace, safe)
        staging = Path(workspace).parent / f".{Path(workspace).name}.container-export"
        backup = Path(workspace).parent / f".{Path(workspace).name}.trusted-backup"
        try:
            self._checked(create_command)
            self._checked(["docker", "start", safe])
            self._stream_workspace(safe, workspace)
            exec_environment = [item for key, value in sorted(environment.items()) for item in ("--env", f"{key}={value}")]
            outcome = self.runner.run_raw(
                [
                    "docker", "exec", "--user", "65532:65532", *exec_environment, safe,
                    self._RUNTIME_WRAPPER, "execute", "--", *profile.fixed_argv,
                ],
                environment,
            )
            if outcome.return_code == 0 and outcome.termination_reason is None:
                if staging.exists():
                    shutil.rmtree(staging, ignore_errors=True)
                # Docker's daemon-side copy path does not expose mounted tmpfs
                # content. Export through the fixed runtime and extract into a
                # host-owned root with traversal and symlink-pivot checks.
                staging.mkdir(mode=0o700)
                self._export_workspace(safe, staging)
                original = Path(workspace)
                trusted_git = original / ".git"
                if not trusted_git.is_dir() or trusted_git.is_symlink():
                    raise WorkspaceError("trusted workspace Git metadata is unavailable")
                untrusted_git = staging / ".git"
                if os.path.lexists(untrusted_git):
                    if untrusted_git.is_symlink() or untrusted_git.is_file():
                        untrusted_git.unlink()
                    else:
                        shutil.rmtree(untrusted_git)
                shutil.copytree(trusted_git, untrusted_git, symlinks=True)
                if backup.exists():
                    raise WorkspaceError("trusted workspace backup already exists")
                original.replace(backup)
                try:
                    staging.replace(original)
                except BaseException:
                    backup.replace(original)
                    raise
                shutil.rmtree(backup)
            elif b"no space left on device" in (outcome.stdout + outcome.stderr).lower():
                outcome = BoundedExecutionResult(
                    outcome.return_code, outcome.stdout, outcome.stderr, "WORKSPACE_LIMIT",
                    outcome.elapsed_seconds, outcome.process_tree_terminated,
                )
            return outcome
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
            if backup.exists():
                if not Path(workspace).exists():
                    backup.replace(Path(workspace))
                else:
                    shutil.rmtree(backup, ignore_errors=True)
            self._remove_container(safe)


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
        git_executable = shutil.which("git")
        if git_executable is None:
            raise WorkspaceError("trusted Git executable is unavailable")
        tool_environment = BoundedExecutionRunner._child_environment({
            "PATH": os.pathsep.join((str(Path(git_executable).parent), os.defpath)),
        })
        try:
            git_exec_path = subprocess.check_output(
                [git_executable, "--exec-path"], text=True, stderr=subprocess.PIPE,
                env=tool_environment,
            ).strip()
        except (OSError, subprocess.CalledProcessError) as error:
            raise WorkspaceError("trusted Git runtime is unavailable") from error
        git_environment = BoundedExecutionRunner._child_environment({
            "PATH": os.pathsep.join((str(Path(git_executable).parent), git_exec_path, os.defpath)),
            "GIT_EXEC_PATH": git_exec_path,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_PROTOCOL_FROM_USER": "0",
            "GIT_ALLOW_PROTOCOL": "file",
        })
        try:
            subprocess.run(
                [git_executable, "clone", "--quiet", "--no-hardlinks", "--no-checkout", str(source), str(target)],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=git_environment,
            )
            subprocess.run(
                [git_executable, "-C", str(target), "checkout", "--quiet", "--detach", request.base_sha],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=git_environment,
            )
            observed = subprocess.check_output(
                [git_executable, "-C", str(target), "rev-parse", "HEAD"], text=True,
                stderr=subprocess.PIPE, env=git_environment,
            ).strip()
            if observed != request.base_sha:
                raise WorkspaceError("workspace HEAD does not match immutable base SHA")
        except subprocess.CalledProcessError as error:
            if target.exists() and target.parent == self.root:
                shutil.rmtree(target, ignore_errors=True)
            detail = (error.stderr or b"")[:256]
            if isinstance(detail, bytes):
                detail = detail.decode("utf-8", errors="replace")
            raise WorkspaceError(f"failed to create exact-base isolated workspace: {detail.strip()}") from error
        except Exception as error:
            if target.exists() and target.parent == self.root:
                shutil.rmtree(target, ignore_errors=True)
            if isinstance(error, WorkspaceError):
                raise
            raise WorkspaceError("failed to create exact-base isolated workspace") from error
        return ExecutionWorkspace(path=target, identity=safe_identity, base_sha=request.base_sha)

    def destroy(self, workspace: Path | str) -> None:
        target = Path(workspace).resolve()
        if target.parent != self.root:
            raise WorkspaceError("workspace cleanup target is outside the configured root")
        if target.exists():
            shutil.rmtree(target)


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
        self.runner = runner or DockerContainerJobRunner(policy)
        self._gateway_sessions: dict[tuple[str, str], str] = {}
        self._session_lock = threading.Lock()

    def bind_gateway_session(self, request: NormalizedExecutionRequest, token: str) -> None:
        if not isinstance(token, str) or len(token) < 64:
            raise WorkspaceError("trusted gateway session token is invalid")
        key = (request.task_fingerprint, request.attempt_id)
        with self._session_lock:
            if key in self._gateway_sessions:
                raise WorkspaceError("gateway session replay binding is denied")
            self._gateway_sessions[key] = token

    def invoke(
        self,
        profile: ExecutorProfile,
        request: NormalizedExecutionRequest,
        workspace: str,
    ) -> Mapping[str, object]:
        environment = sanitized_executor_environment(os.environ, request, self.policy)
        key = (request.task_fingerprint, request.attempt_id)
        with self._session_lock:
            gateway_token = self._gateway_sessions.pop(key, None)
        if gateway_token is not None:
            environment["EXEC_GATEWAY_SESSION_TOKEN"] = gateway_token
        outcome = self.runner.run_container(profile, self.policy, request, workspace, environment)
        if outcome.termination_reason is not None:
            failure_type = "resource_limit" if outcome.termination_reason == "WORKSPACE_LIMIT" else "timeout"
            if profile.provider == "codex":
                return {
                    "protocol": "codex-exec-jsonl-v1",
                    "status": "failed" if failure_type == "resource_limit" else "timed_out", "started_at": "1970-01-01T00:00:00Z",
                    "completed_at": "1970-01-01T00:00:00Z", "commands": [], "tests": [],
                    "changed_paths": [], "patch_digest": None, "log_refs": [], "error_type": failure_type,
                }
            return {
                "protocol": "claude-code-stream-json-v1",
                "stop_reason": "error" if failure_type == "resource_limit" else "timeout", "startedAt": "1970-01-01T00:00:00Z",
                "completedAt": "1970-01-01T00:00:00Z", "commandsExecuted": [], "testOutcomes": [],
                "changedPaths": [], "patchDigest": None, "evidenceReferences": [], "errorType": failure_type,
            }
        if outcome.return_code != 0:
            diagnostic = outcome.stderr.decode("utf-8", errors="replace")[:256].strip()
            raise WorkspaceError(
                f"source-controlled provider wrapper exited {outcome.return_code}: {diagnostic}"
            )
        try:
            raw = json.loads(outcome.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise WorkspaceError("provider launcher returned malformed JSON") from error
        if not isinstance(raw, dict):
            raise WorkspaceError("provider launcher result must be a JSON object")
        return raw

    def cancel(self, request: NormalizedExecutionRequest) -> None:
        cancel = getattr(self.runner, "cancel", None)
        if not callable(cancel):
            raise WorkspaceError("provider runner does not support task-bound cancellation")
        cancel(request)
