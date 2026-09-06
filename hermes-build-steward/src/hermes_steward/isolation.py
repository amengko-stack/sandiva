from __future__ import annotations

import os
import re
import shlex
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Mapping, Sequence

from .contracts import validate_verification_command


@dataclass(frozen=True)
class IsolationPolicy:
    image: str
    cpu_limit: str
    memory_limit: str
    pids_limit: int
    tmpfs_size: str
    timeout_seconds: int
    output_limit_bytes: int
    network_mode: str = "none"

    def __post_init__(self) -> None:
        if "@sha256:" not in self.image:
            raise ValueError("verification image must be pinned by digest")
        if self.network_mode != "none":
            raise ValueError("Phase 1 default verification network must be none")
        if self.pids_limit < 1 or self.timeout_seconds < 1 or self.output_limit_bytes < 1:
            raise ValueError("verification resource bounds must be positive")


def sanitized_job_environment(host_environment: Mapping[str, str], approved: Mapping[str, str]) -> dict[str, str]:
    del host_environment
    allowed_prefixes = ("HERMES_TASK_ID", "HERMES_ATTEMPT_ID", "CI", "LANG", "LC_ALL")
    result = {}
    for key, value in approved.items():
        if key not in allowed_prefixes:
            raise ValueError(f"job environment variable is not allowlisted: {key}")
        result[key] = value
    return result


def build_docker_command(
    policy: IsolationPolicy,
    input_workspace: str,
    verification_command: Sequence[str],
    *,
    cidfile: str | None = None,
) -> list[str]:
    workspace = Path(input_workspace)
    is_absolute = workspace.is_absolute() or PurePosixPath(input_workspace).is_absolute()
    if not is_absolute:
        raise ValueError("input workspace must be absolute")
    if not verification_command or any(not isinstance(part, str) or not part for part in verification_command):
        raise ValueError("verification command must be a non-empty argument vector")
    source = PurePosixPath(input_workspace).as_posix() if input_workspace.startswith("/") else workspace.as_posix()
    command_text = "cp -a /input/. /workspace/ && cd /workspace && exec " + shlex.join(list(verification_command))
    command = [
        "docker", "run", "--rm", "--init", "--network", policy.network_mode,
        "--cpus", policy.cpu_limit, "--memory", policy.memory_limit,
        "--pids-limit", str(policy.pids_limit), "--read-only",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "65532:65532",
        "--mount", f"type=bind,src={source},dst=/input,readonly",
        "--tmpfs", f"/workspace:rw,nosuid,nodev,size={policy.tmpfs_size}",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
        policy.image, "/bin/sh", "-lc", command_text,
    ]
    if cidfile is not None:
        cid_path = Path(cidfile)
        if not cid_path.is_absolute() and not PurePosixPath(cidfile).is_absolute():
            raise ValueError("container ID file must be absolute")
        command[4:4] = ["--cidfile", cid_path.as_posix()]
    return command


@dataclass(frozen=True)
class ProcessResult:
    return_code: int | None
    stdout: bytes
    stderr: bytes
    terminated: bool
    termination_reason: str | None
    elapsed_seconds: float
    container_cleanup: str = "NOT_APPLICABLE"


class BoundedProcessRunner:
    """Run the Docker client or a synthetic subprocess with bounded time and output."""

    def __init__(self, policy: IsolationPolicy):
        self.policy = policy

    def run_verification(
        self,
        task: Mapping[str, object],
        input_workspace: str,
        verification_command: Sequence[str],
        *,
        approved_job_environment: Mapping[str, str] | None = None,
    ) -> ProcessResult:
        validate_verification_command(task, verification_command)
        job_environment = sanitized_job_environment({}, approved_job_environment or {})
        with tempfile.TemporaryDirectory(prefix="hermes-container-control-") as control_directory:
            cidfile = str(Path(control_directory, "job.cid"))
            command = build_docker_command(self.policy, input_workspace, verification_command, cidfile=cidfile)
            for key, value in sorted(job_environment.items()):
                command[2:2] = ["--env", f"{key}={value}"]
            return self.run_raw(command, container_cidfile=cidfile)

    def run_raw(
        self,
        command: Sequence[str],
        *,
        host_environment: Mapping[str, str] | None = None,
        container_cidfile: str | None = None,
    ) -> ProcessResult:
        del host_environment
        child_environment = {"PATH": os.defpath, "LANG": "C.UTF-8"}
        if os.name == "nt" and "SYSTEMROOT" in os.environ:
            child_environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        started = time.monotonic()
        process = subprocess.Popen(
            list(command), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=child_environment,
        )
        captured = {"stdout": bytearray(), "stderr": bytearray()}
        total = 0
        lock = threading.Lock()
        limit_exceeded = threading.Event()

        def drain(name: str, stream) -> None:
            nonlocal total
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                with lock:
                    remaining = max(0, self.policy.output_limit_bytes - total)
                    accepted = chunk[:remaining]
                    captured[name].extend(accepted)
                    total += len(accepted)
                    if len(chunk) > remaining:
                        limit_exceeded.set()

        threads = [
            threading.Thread(target=drain, args=("stdout", process.stdout), daemon=True),
            threading.Thread(target=drain, args=("stderr", process.stderr), daemon=True),
        ]
        for thread in threads:
            thread.start()

        termination_reason = None
        while process.poll() is None:
            elapsed = time.monotonic() - started
            if limit_exceeded.is_set():
                termination_reason = "OUTPUT_LIMIT"
                process.terminate()
                break
            if elapsed >= self.policy.timeout_seconds:
                termination_reason = "TIME_LIMIT"
                process.terminate()
                break
            time.sleep(0.01)
        if termination_reason is not None:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
        process.wait()
        for thread in threads:
            thread.join(timeout=2)
        if process.stdout is not None:
            process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()
        if limit_exceeded.is_set() and termination_reason is None:
            termination_reason = "OUTPUT_LIMIT"
        cleanup = self._cleanup_container(container_cidfile, child_environment) if container_cidfile else "NOT_APPLICABLE"
        return ProcessResult(
            return_code=process.returncode,
            stdout=bytes(captured["stdout"]), stderr=bytes(captured["stderr"]),
            terminated=termination_reason is not None,
            termination_reason=termination_reason,
            elapsed_seconds=time.monotonic() - started,
            container_cleanup=cleanup,
        )

    @staticmethod
    def _cleanup_container(cidfile: str, child_environment: Mapping[str, str]) -> str:
        path = Path(cidfile)
        if not path.exists():
            return "CID_NOT_CREATED"
        container_id = path.read_text(encoding="ascii").strip()
        if not re.fullmatch(r"[0-9a-f]{12,64}", container_id):
            return "INVALID_CID"
        try:
            completed = subprocess.run(
                ["docker", "rm", "-f", container_id], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=dict(child_environment), timeout=10, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return "CLEANUP_FAILED"
        if completed.returncode == 0:
            return "REMOVED"
        if b"No such container" in completed.stderr:
            return "ALREADY_REMOVED"
        return "CLEANUP_FAILED"
