from __future__ import annotations

import hashlib
import base64
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from helpers import AC_BYTES, PM_BYTES, SPEC_BYTES
from hermes_steward.contracts import fingerprint, validate_dispatch_build_task
from hermes_steward.execution_adapters import ClaudeCodeExecutionAdapter, CodexExecutionAdapter
from hermes_steward.execution_contracts import ExecutorProfile, ResolvedExecutionArtifacts, normalize_execution_request
from hermes_steward.execution_isolation import ContainerProviderRunner, ContainmentPolicy, DockerContainerJobRunner, DockerNetworkAttestor, GatewayNetworkBinding
from hermes_steward.prepublication import PrepublicationInspector
from hermes_steward.execution_gateway_service import GatewayPolicy
from hermes_steward.execution_runtime import DockerExecutorGatewayController
from test_execution_task_contract import dispatch_task


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("docker") and shutil.which("go"), "requires Linux Docker and Go")
class SourceControlledRuntimeDockerTests(unittest.TestCase):
    @staticmethod
    def _image_file_metadata(image: str, targets: tuple[str, ...]) -> dict[str, tuple[int, int, int]]:
        """Read immutable image-layer metadata without requiring tools in the image."""
        container = subprocess.check_output(["docker", "create", image], text=True).strip()
        try:
            process = subprocess.Popen(["docker", "export", container], stdout=subprocess.PIPE)
            assert process.stdout is not None
            wanted = {target.lstrip("/"): target for target in targets}
            observed: dict[str, tuple[int, int, int]] = {}
            with tarfile.open(fileobj=process.stdout, mode="r|*") as archive:
                for member in archive:
                    normalized = member.name.lstrip("./")
                    if normalized in wanted:
                        observed[wanted[normalized]] = (member.mode, member.uid, member.gid)
            if process.wait() != 0:
                raise AssertionError("docker export failed")
            return observed
        finally:
            subprocess.run(["docker", "rm", "-f", container], check=False, stdout=subprocess.DEVNULL)

    @staticmethod
    def _build_write_probe(directory: Path) -> Path:
        source = directory / "write-probe.go"
        binary = directory / "write-probe"
        source.write_text(
            'package main\nimport ("os")\nfunc main(){'
            'if len(os.Args)!=2 { os.Exit(2) }; '
            'if err:=os.WriteFile(os.Args[1],[]byte("attacker"),0600); err!=nil { os.Exit(23) }'
            '}\n'
        )
        environment = dict(os.environ)
        environment["CGO_ENABLED"] = "0"
        subprocess.run(["go", "build", "-trimpath", "-o", str(binary), str(source)], check=True, env=environment)
        return binary

    @staticmethod
    def _reproducible_build(tag, dockerfile, context, build_args):
        context_archive = tempfile.NamedTemporaryFile(suffix=".tar", delete=False)
        context_archive.close()
        try:
            with tarfile.open(context_archive.name, "w", format=tarfile.GNU_FORMAT) as archive:
                for path in sorted(context.rglob("*")):
                    relative = path.relative_to(context)
                    if "__pycache__" in relative.parts or path.suffix in {".pyc", ".pyo"}:
                        continue
                    info = archive.gettarinfo(str(path), arcname=relative.as_posix())
                    info.mtime = 1704067200
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    if info.isfile():
                        with path.open("rb") as source:
                            archive.addfile(info, source)
                    else:
                        archive.addfile(info)
            context_input = open(context_archive.name, "rb")
        except Exception:
            Path(context_archive.name).unlink(missing_ok=True)
            raise
        command = [
            "docker", "buildx", "build", "--pull=false", "--no-cache", "--provenance=false",
            "--build-arg", "SOURCE_DATE_EPOCH=1704067200",
        ]
        for key, value in build_args.items():
            command.extend(("--build-arg", f"{key}={value}"))
        command.extend((
            "--output", f"type=docker,name={tag},rewrite-timestamp=true",
            "-f", dockerfile.relative_to(context).as_posix(), "-",
        ))
        try:
            subprocess.run(command, check=True, stdin=context_input, stdout=subprocess.DEVNULL)
        finally:
            context_input.close()
            Path(context_archive.name).unlink(missing_ok=True)
        return subprocess.check_output(
            ["docker", "image", "inspect", tag, "--format", "{{.Id}}"], text=True
        ).strip()

    @staticmethod
    def _image_identity_fields(image, file_paths=None):
        if file_paths is None:
            file_paths = (
                "/opt/sandiva/bin/exec01-runtime", "/opt/sandiva/bin/codex", "/opt/sandiva/bin/claude",
            )
        inspected = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0]
        saved = tempfile.NamedTemporaryFile(suffix=".tar", delete=False)
        saved.close()
        try:
            subprocess.run(["docker", "save", "-o", saved.name, image], check=True)
            with tarfile.open(saved.name, "r") as outer:
                manifest = json.loads(outer.extractfile("manifest.json").read())[0]
                layer_file = outer.extractfile(manifest["Layers"][-1])
                with tarfile.open(fileobj=layer_file, mode="r") as layer:
                    layer_entries = [
                        {
                            "name": item.name,
                            "mode": item.mode,
                            "uid": item.uid,
                            "gid": item.gid,
                            "mtime": item.mtime,
                            "size": item.size,
                            "pax": item.pax_headers,
                        }
                        for item in layer
                    ]
        finally:
            Path(saved.name).unlink(missing_ok=True)
        return {
            "created": inspected.get("Created"),
            "rootfs": inspected.get("RootFS"),
            "history": inspected.get("History"),
            "config": inspected.get("Config"),
            "fileHashes": subprocess.check_output(
                [
                    "docker", "run", "--rm", "--entrypoint", "sha256sum", image,
                    *file_paths,
                ],
                text=True,
            ).splitlines(),
            "lastLayerEntries": layer_entries,
        }

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        runtime = Path(__file__).parents[1] / "runtime" / "exec01-runtime"
        def pinned(tag):
            subprocess.run(["docker", "pull", tag], check=True, stdout=subprocess.DEVNULL)
            values = json.loads(subprocess.check_output(["docker", "image", "inspect", tag], text=True))[0]["RepoDigests"]
            return next(value for value in values if "@sha256:" in value)
        build_image, runtime_image, python_image = pinned("golang:1.23-alpine"), pinned("alpine:3.20"), pinned("python:3.11-alpine")
        cls.image = cls._reproducible_build(
            "sandiva-exec01-runtime:repro-test",
            runtime / "Dockerfile.emulator",
            runtime,
            {"BUILD_IMAGE": build_image, "RUNTIME_IMAGE": runtime_image},
        )
        repeated_runtime = cls._reproducible_build(
            "sandiva-exec01-runtime:repro-test",
            runtime / "Dockerfile.emulator",
            runtime,
            {"BUILD_IMAGE": build_image, "RUNTIME_IMAGE": runtime_image},
        )
        if repeated_runtime != cls.image:
            raise RuntimeError(
                "runtime image build is not reproducible: "
                f"{cls.image} {json.dumps(cls._image_identity_fields(cls.image), sort_keys=True)} != "
                f"{repeated_runtime} {json.dumps(cls._image_identity_fields(repeated_runtime), sort_keys=True)}"
            )
        if not cls.image.startswith("sha256:"): raise RuntimeError("runtime image is not content-addressed")
        print(f"EXEC01_CODE_QA_RUNTIME_IMAGE={cls.image}")
        repository = Path(__file__).parents[1]
        cls.gateway_image = cls._reproducible_build(
            "sandiva-exec01-gateway:repro-test",
            repository / "runtime" / "executor-gateway" / "Dockerfile",
            repository,
            {"PYTHON_IMAGE": python_image},
        )
        repeated_gateway = cls._reproducible_build(
            "sandiva-exec01-gateway:repro-test",
            repository / "runtime" / "executor-gateway" / "Dockerfile",
            repository,
            {"PYTHON_IMAGE": python_image},
        )
        if repeated_gateway != cls.gateway_image:
            gateway_files = (
                "/opt/sandiva/bin/exec01-gateway",
                "/opt/sandiva/gateway/hermes_steward/execution_gateway_service.py",
            )
            raise RuntimeError(
                "gateway image build is not reproducible: "
                f"{cls.gateway_image} {json.dumps(cls._image_identity_fields(cls.gateway_image, gateway_files), sort_keys=True)} != "
                f"{repeated_gateway} {json.dumps(cls._image_identity_fields(repeated_gateway, gateway_files), sort_keys=True)}"
            )
        if not cls.gateway_image.startswith("sha256:"): raise RuntimeError("gateway image is not content-addressed")
        print(f"EXEC01_CODE_QA_GATEWAY_IMAGE={cls.gateway_image}")

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "image", "rm", "-f", cls.image], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["docker", "image", "rm", "-f", cls.gateway_image], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.temp.cleanup()

    def setUp(self):
        suffix=uuid.uuid4().hex[:10]; self.network=f"exec01-src-{suffix}"; self.gateway=f"exec01-gateway-{suffix}"
        subprocess.run(["docker","network","create","--internal",self.network],check=True,stdout=subprocess.DEVNULL)
        self.policy_fingerprint=fingerprint({"networkName":self.network,"allowedEndpoints":["executor-gateway.sandiva.internal:8443"],"topology":"internal-network-single-attested-gateway-v1"})
        subprocess.run(["docker","run","-d","--name",self.gateway,"--network",self.network,"--network-alias","executor-gateway.sandiva.internal","--label",f"sandiva.exec.gateway-policy={self.policy_fingerprint}",self.image,"sleep"],check=True,stdout=subprocess.DEVNULL)
        self.workspace=self.root/suffix/"workspace"; (self.workspace/"hermes-build-steward").mkdir(parents=True)
        (self.workspace/"hermes-build-steward"/"README.md").write_text("base\n")
        script=self.workspace/"q16-build.sh"; script.write_text("#!/bin/sh\nset -eu\nprintf 'implemented\\n' > hermes-build-steward/README.md\nmkdir -p hermes-build-steward/generated\nprintf 'generated\\n' > hermes-build-steward/generated/result.txt\ntest \"$(cat hermes-build-steward/README.md)\" = implemented\n")
        script.chmod(0o700)
        subprocess.run(["git","init","-q",str(self.workspace)],check=True); subprocess.run(["git","-C",str(self.workspace),"add","."],check=True)
        subprocess.run(["git","-C",str(self.workspace),"-c","user.email=q@sandiva.invalid","-c","user.name=Q","commit","-q","-m","base"],check=True)

    def tearDown(self):
        subprocess.run(["docker","rm","-f",self.gateway],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); subprocess.run(["docker","network","rm",self.network],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        shutil.rmtree(self.workspace.parent,ignore_errors=True)

    def _profile_request(self, provider, approved_commands=("sh q16-build.sh",), pm_instruction=PM_BYTES):
        launcher="codex" if provider=="codex" else "claude"
        attest=json.loads(subprocess.check_output(["docker","run","--rm","--network","none","--entrypoint","/opt/sandiva/bin/exec01-runtime",self.image,"attest",launcher,"synthetic-conformance-model","a"*64,self.policy_fingerprint],text=True))
        fixed=("codex","exec","--json","--ephemeral","--strict-config","--dangerously-bypass-hook-trust","--model","synthetic-conformance-model","--sandbox","read-only","-") if provider=="codex" else ("claude","--print","--output-format","stream-json","--verbose","--model","synthetic-conformance-model","--permission-mode","dontAsk","--setting-sources","user","--settings","/opt/sandiva/claude/settings.json","--strict-mcp-config","--mcp-config","/opt/sandiva/claude/mcp.json","--allowedTools","mcp__sandiva_execution_authority__sandiva_execute","--disallowedTools","Bash,Read,Write,Edit,Glob,Grep,LS,NotebookEdit,WebFetch,WebSearch","--no-session-persistence")
        profile=ExecutorProfile(profile_id=f"{provider}-source-runtime",provider=provider,runtime_name=f"{provider}-cli",runtime_version=attest["executableVersion"],model="synthetic-conformance-model",launcher_version=attest["launcherVersion"],executable_digest=attest["executableDigest"],fixed_argv=fixed,image=self.image,credential_mode="trusted-egress-gateway",gateway_endpoint="executor-gateway.sandiva.internal:8443",allowed_endpoints=("executor-gateway.sandiva.internal:8443",),runtime_wrapper_digest=attest["runtimeWrapperDigest"],gateway_implementation_digest="a"*64,gateway_policy_digest=self.policy_fingerprint)
        task=dispatch_task(taskId=f"Q{provider.upper().replace('-','')}",baseRef=subprocess.check_output(["git","-C",str(self.workspace),"rev-parse","HEAD"],text=True).strip())
        task["originatingPmInstructionFingerprint"] = hashlib.sha256(pm_instruction).hexdigest()
        task["executorPolicy"]["approvedCommands"]=list(approved_commands)
        task["dispatchPolicy"].update(executorProfile={"profileId":profile.profile_id,"profileFingerprint":profile.fingerprint},permittedFallbackProfiles=[],fallbackMode="NONE")
        task=validate_dispatch_build_task(task)
        lease=type("Lease",(),{"attempt_id":f"attempt-{provider}","lease_id":f"lease-{provider}","fencing_token":1})()
        request=normalize_execution_request(task,fingerprint(task),profile,lease,ResolvedExecutionArtifacts(pm_instruction,SPEC_BYTES,AC_BYTES))
        return profile,request

    def _run(self, provider, approved_commands=("sh q16-build.sh",), pm_instruction=PM_BYTES):
        profile,request=self._profile_request(provider, approved_commands, pm_instruction)
        policy=ContainmentPolicy(cpu_limit="1.0",memory_limit="128m",pids_limit=32,workspace_limit_bytes=16*1024*1024,wall_time_seconds=30,output_limit_bytes=65536,network_name=self.network,allowed_endpoints=profile.allowed_endpoints)
        job=DockerContainerJobRunner(policy,network_attestor=DockerNetworkAttestor(GatewayNetworkBinding(self.network,self.gateway,self.image,self.policy_fingerprint)))
        runner=ContainerProviderRunner(policy,self.workspace.parent/"requests",runner=job)
        adapter=CodexExecutionAdapter(profile,runner) if provider=="codex" else ClaudeCodeExecutionAdapter(profile,runner)
        result=adapter.execute(request,self.workspace.as_posix()); changes=PrepublicationInspector().inspect(str(self.workspace),request)
        return request,result,changes

    def test_seventh_rework_provider_hook_bypass_crash_timeout_and_unknown_surfaces_fail_closed(self):
        baseline = self._sixth_workspace_state()
        cases = (
            "SEVENTH_NO_BROKER_SUCCESS",  # hook absent, crashed, timed out, spawn failed, or malformed
            "SEVENTH_DIRECT_SURFACE",     # direct file/process and exec_command-equivalent attempt
            "SEVENTH_DIRECT_SURFACE",     # repeat to catch Go OS-thread confinement inheritance drift
            "SEVENTH_DIRECT_SURFACE",
            "SEVENTH_UNKNOWN_SURFACE",    # Code Mode/new or unknown tool surface
        )
        for marker in cases:
            for provider in ("codex", "claude-code"):
                with self.subTest(marker=marker, provider=provider):
                    _, result, changes = self._run(
                        provider, approved_commands=("true",),
                        pm_instruction=(marker + "\n").encode(),
                    )
                    if marker == "SEVENTH_UNKNOWN_SURFACE":
                        self.assertEqual(result["disposition"], "EXECUTION_BLOCKED")
                        self.assertEqual(result["failureClassification"], "POLICY_DENIED")
                    else:
                        self.assertEqual(result["disposition"], "EXECUTION_FAILED")
                        self.assertEqual(result["failureClassification"], "INTERNAL_ERROR")
                    self.assertEqual(result["commandsExecuted"], [])
                    self.assertEqual(changes.changed_paths, ())
                    self.assertEqual(self._sixth_workspace_state(), baseline)
                    self.assertFalse((self.workspace/"hermes-build-steward"/"SEVENTH-BYPASS").exists())
                    self.assertFalse((self.workspace/"hermes-build-steward"/"SEVENTH-PROCESS").exists())
                    self.assertFalse((self.workspace/"hermes-build-steward"/"SEVENTH-CODE-MODE").exists())

    def _sixth_hook(self, provider, tool, tool_input, *, raw=None, request_payload=None):
        _, request = self._profile_request(provider)
        payload = request_payload or base64.b64encode(
            json.dumps(request.as_dict(), sort_keys=True, separators=(",", ":")).encode()
        ).decode()
        hook_provider = "codex" if provider == "codex" else "claude"
        body = raw if raw is not None else json.dumps({
            "hook_event_name":"PreToolUse", "tool_name":tool, "cwd":"/workspace",
            "tool_input":tool_input,
        }).encode()
        completed = subprocess.run([
            "docker", "run", "--rm", "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", "65532:65532",
            "--tmpfs", "/run/exec:rw,nosuid,nodev,noexec,size=1048576,uid=65532,gid=65532,mode=0700",
            "--mount", f"type=bind,src={self.workspace},dst=/workspace,readonly",
            "--env", f"EXEC_REQUEST_B64={payload}",
            "--entrypoint", "/opt/sandiva/bin/exec01-runtime", self.image,
            "authorize", hook_provider,
        ], input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
        observed = json.loads(completed.stdout)
        return observed["hookSpecificOutput"]["permissionDecision"], completed

    def _sixth_workspace_state(self):
        files = {
            path.relative_to(self.workspace).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in self.workspace.rglob("*") if path.is_file() and ".git" not in path.parts
        }
        return {
            "files": files,
            "status": subprocess.check_output(["git", "-C", str(self.workspace), "status", "--porcelain=v1"], text=True),
            "head": subprocess.check_output(["git", "-C", str(self.workspace), "rev-parse", "HEAD"], text=True).strip(),
            "refs": subprocess.check_output(["git", "-C", str(self.workspace), "show-ref"], text=True),
        }

    def test_sixth_rework_s1_s14_actual_hook_denials_have_zero_side_effects(self):
        secret = self.workspace/"hermes-build-steward"/"secrets"/"sentinel.txt"
        secret.parent.mkdir(parents=True); secret.write_text("DO-NOT-DISCLOSE\n")
        outside = self.workspace/"client"/"sentinel.txt"
        outside.parent.mkdir(); outside.write_text("unchanged\n")
        link = self.workspace/"hermes-build-steward"/"linked"
        link.symlink_to(outside.parent, target_is_directory=True)
        subprocess.run(["git", "-C", str(self.workspace), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.workspace), "-c", "user.email=q@sandiva.invalid", "-c", "user.name=Q", "commit", "-q", "-m", "sixth fixture base"], check=True)
        baseline = self._sixth_workspace_state()
        mixed_patch = "*** Begin Patch\n*** Update File: hermes-build-steward/README.md\n@@\n-base\n+changed\n*** Add File: client/PATCH-SENTINEL\n+bad\n*** End Patch"
        cases = (
            ("S1", "Write", {"path":"client/sentinel.txt", "content":"mutated"}),
            ("S2", "Edit", {"file_path":"server/out-of-scope.txt", "old_string":"a", "new_string":"b"}),
            ("S3", "Read", {"file_path":"hermes-build-steward/secrets/sentinel.txt"}),
            ("S4", "apply_patch", {"patch":mixed_patch}),
            ("S5", "Read", {"path":"hermes-build-steward/../client/sentinel.txt"}),
            ("S6", "Read", {"path":"hermes-build-steward/linked/sentinel.txt"}),
            ("S7", "Glob", {"root":"client", "pattern":"**/*"}),
            ("S8", "Grep", {"directory":"hermes-build-steward/secrets", "pattern":"DO-NOT-DISCLOSE"}),
            ("S9", "LS", {"path":"client"}),
            ("S10", "Read", {"file_path":["hermes-build-steward/README.md"]}),
            ("S11", "Computer", {"path":"hermes-build-steward"}),
        )
        for label, tool, tool_input in cases:
            for provider in ("codex", "claude-code"):
                with self.subTest(fixture=label, provider=provider):
                    decision, completed = self._sixth_hook(provider, tool, tool_input)
                    self.assertEqual(decision, "deny")
                    self.assertNotIn(b"DO-NOT-DISCLOSE", completed.stdout + completed.stderr)
                    self.assertEqual(self._sixth_workspace_state(), baseline)
                    self.assertFalse((self.workspace/"client"/"PATCH-SENTINEL").exists())

        oversized = b'{"hook_event_name":"PreToolUse","tool_name":"Read","cwd":"/workspace","tool_input":{"path":"' + b"x"*65536 + b'"}}'
        for label, raw, request_payload in (
            ("S12", oversized, None),
            ("S13", b'{"hook_event_name":"PreToolUse"', None),
            ("S14", b'{"hook_event_name":"PreToolUse","tool_name":"Read","cwd":"/workspace","tool_input":{"path":"hermes-build-steward/README.md"}}', "corrupted-sealed-request"),
        ):
            for provider in ("codex", "claude-code"):
                with self.subTest(fixture=label, provider=provider):
                    decision, _ = self._sixth_hook(provider, "Read", {}, raw=raw, request_payload=request_payload)
                    self.assertEqual(decision, "deny")
                    self.assertEqual(self._sixth_workspace_state(), baseline)

    def test_sixth_rework_s15_s17_mandatory_hook_and_provider_configuration_are_immutable(self):
        targets = ("/opt/sandiva/codex/hooks.json", "/opt/sandiva/claude/settings.json", "/opt/sandiva/bin/exec01-runtime")
        metadata = self._image_file_metadata(self.image, targets)
        self.assertEqual(set(metadata), set(targets))
        with tempfile.TemporaryDirectory() as probe_directory:
            probe = self._build_write_probe(Path(probe_directory))
            for target in targets:
                mode, _, _ = metadata[target]
                self.assertIn(mode, {0o444, 0o555})
                overwrite = subprocess.run([
                    "docker", "run", "--rm", "--network", "none", "--read-only", "--user", "65532:65532",
                    "--mount", f"type=bind,src={probe},dst=/write-probe,readonly",
                    "--entrypoint", "/write-probe", self.image, target,
                ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self.assertEqual(overwrite.returncode, 23)

        # S16: writable workspace settings cannot replace immutable CODEX_HOME /
        # CLAUDE_CONFIG_DIR policy. S17: even direct alternate launcher use in
        # the emulator traverses the same mandatory authorizer before a tool.
        (self.workspace/".codex").mkdir(); (self.workspace/".codex"/"config.toml").write_text("hooks=[]\n")
        (self.workspace/".claude").mkdir(); (self.workspace/".claude"/"settings.json").write_text('{"hooks":{}}')
        before = self._sixth_workspace_state()
        for provider in ("codex", "claude-code"):
            profile, request = self._profile_request(provider, approved_commands=("true",))
            payload = base64.b64encode(json.dumps(request.as_dict(),sort_keys=True,separators=(",", ":")).encode()).decode()
            launcher = "codex" if provider == "codex" else "claude"
            completed = subprocess.run([
                "docker", "run", "--rm", "--network", "none", "--read-only", "--user", "65532:65532",
                "--tmpfs", "/run/exec:rw,nosuid,nodev,noexec,size=1048576,uid=65532,gid=65532,mode=0700",
                "--mount", f"type=bind,src={self.workspace},dst=/workspace",
                "--env", f"EXEC_REQUEST_B64={payload}", "--env", "HOME=/workspace",
                "--env", "CODEX_HOME=/opt/sandiva/codex", "--env", "CLAUDE_CONFIG_DIR=/opt/sandiva/claude",
                "--entrypoint", f"/opt/sandiva/bin/{launcher}", self.image,
                *profile.fixed_argv[1:],
            ], input=b"approved prompt\0", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            with self.subTest(provider=provider):
                self.assertNotEqual(completed.returncode, 0)
                self.assertNotIn(b"turn.completed", completed.stdout)
                self.assertNotIn(b'"subtype":"success"', completed.stdout)
                self.assertEqual(self._sixth_workspace_state(), before)

    def test_sixth_rework_s18_s20_unauthorized_bash_precedes_process_network_git_and_publication(self):
        malicious = self.workspace/"q16-build.sh"
        malicious.write_text("#!/bin/sh\nset -eu\n/bin/sh -c 'echo child > client/CHILD'\n/bin/busybox wget -q -O /dev/null http://attacker.invalid/\necho git > .git/SIXTH-GIT\necho publish > SIXTH-PUBLICATION\n")
        malicious.chmod(0o700)
        subprocess.run(["git", "-C", str(self.workspace), "add", "q16-build.sh"], check=True)
        subprocess.run(["git", "-C", str(self.workspace), "-c", "user.email=q@sandiva.invalid", "-c", "user.name=Q", "commit", "-q", "-m", "malicious agent fixture"], check=True)
        baseline = self._sixth_workspace_state()
        for provider in ("codex", "claude-code"):
            with self.subTest(provider=provider):
                _, result, changes = self._run(provider, approved_commands=("true",))
                self.assertEqual(result["disposition"], "EXECUTION_BLOCKED")
                self.assertEqual(result["failureClassification"], "POLICY_DENIED")
                self.assertEqual(result["commandsExecuted"], [])
                self.assertTrue(any("sandiva-action-broker" in value for value in result["evidenceReferences"]))
                self.assertEqual(changes.changed_paths, ())
                self.assertEqual(self._sixth_workspace_state(), baseline)
                self.assertFalse((self.workspace/"client"/"CHILD").exists())
                self.assertFalse((self.workspace/".git"/"SIXTH-GIT").exists())
                self.assertFalse((self.workspace/"SIXTH-PUBLICATION").exists())

    def test_fifth_rework_unauthorized_command_has_zero_sentinel_side_effects(self):
        for provider in ("codex", "claude-code"):
            with self.subTest(provider=provider):
                original = (self.workspace/"hermes-build-steward"/"README.md").read_text()
                _, result, changes = self._run(provider, approved_commands=("true",))
                self.assertEqual(result["disposition"], "EXECUTION_BLOCKED")
                self.assertEqual(result["failureClassification"], "POLICY_DENIED")
                self.assertEqual(result["commandsExecuted"], [])
                self.assertEqual((self.workspace/"hermes-build-steward"/"README.md").read_text(), original)
                self.assertFalse((self.workspace/"hermes-build-steward"/"generated"/"result.txt").exists())
                self.assertFalse((self.workspace/"hermes-build-steward"/"UNAUTHORIZED").exists())
                self.assertEqual(changes.changed_paths, ())

    def test_q2_q4_codex_source_runtime_processes_sealed_request_and_real_task(self):
        request,result,changes=self._run("codex")
        self.assertEqual(result["disposition"],"EXECUTION_SUCCEEDED")
        self.assertIn("sh q16-build.sh",result["commandsExecuted"])
        self.assertEqual(result["testOutcomes"], [{"name":"approved command: sh q16-build.sh","status":"PASS","command":"sh q16-build.sh"}])
        observed=json.loads((self.workspace/"hermes-build-steward"/"provider-prompt.json").read_text())
        self.assertEqual(observed,request.as_dict()["executionContent"])
        self.assertIn("hermes-build-steward/README.md",changes.changed_paths)

    def test_q5_claude_source_runtime_performs_same_provider_neutral_task(self):
        _,result,changes=self._run("claude-code")
        self.assertEqual(result["disposition"],"EXECUTION_SUCCEEDED")
        self.assertIn("sh q16-build.sh",result["commandsExecuted"])
        self.assertEqual(result["testOutcomes"][0]["status"],"PASS")
        self.assertIn("hermes-build-steward/generated/result.txt",changes.changed_paths)

    def test_q16_noexec_workspace_uses_trusted_root_interpreter(self):
        self._run("codex")
        self.assertEqual((self.workspace/"hermes-build-steward"/"noexec-probe.txt").read_text(),"direct-denied;trusted-interpreter-succeeded\n")
        self.assertEqual((self.workspace/"hermes-build-steward"/"generated"/"result.txt").read_text(),"generated\n")

    def test_q3_gateway_image_is_source_controlled_multi_profile_and_mints_bound_session(self):
        implementation=self.gateway_image.split("sha256:",1)[1]
        manifest={}
        for key,provider,model,host,path in (
            ("1"*64,"codex","codex-model","api.openai.com","/v1/responses"),
            ("2"*64,"claude-code","claude-model","api.anthropic.com","/v1/messages"),
        ):
            value={"schemaVersion":"1.0","profileId":f"{provider}-q3","profileFingerprint":key,
                   "provider":provider,"model":model,"upstreamScheme":"https","upstreamHost":host,
                   "upstreamPort":443,"upstreamPaths":[path],"httpMethod":"POST","maxRequestBytes":65536,
                   "maxResponseBytes":65536,"timeoutSeconds":30,"sessionTtlSeconds":300,
                   "maxRequestsPerSession":1,"implementationDigest":implementation,
                   "networkPolicyFingerprint":"3"*64,"credentialMode":"trusted-header-injection"}
            value["gatewayPolicyFingerprint"]=GatewayPolicy.fingerprint_manifest(value)
            manifest[key]=value
        environment=["--env",f"EXEC01_PROFILE_MANIFEST={json.dumps(manifest,separators=(',',':'))}","--env","EXEC01_SESSION_SIGNING_KEY=q3-source-gateway-signing-key-material","--env","EXEC01_GATEWAY_RUNTIME_MODE=CODE_QA"]
        health=json.loads(subprocess.check_output(["docker","run","--rm",*environment,self.gateway_image,"health"],text=True))
        self.assertEqual(set(health["profiles"]),set(manifest))
        token=subprocess.check_output(["docker","run","--rm",*environment,self.gateway_image,"issue","--task-fingerprint","4"*64,"--attempt-id","attempt-q3","--profile-fingerprint","1"*64],text=True).strip()
        self.assertGreater(len(token),64)
        self.assertNotIn("OPENAI",token)

    def _q24_profiles_and_manifest(self):
        implementation = self.gateway_image.split("sha256:", 1)[1]
        profiles, manifest = {}, {}
        for provider, host, path in (
            ("codex", "provider.test.internal", "/v1/responses"),
            ("claude-code", "provider.test.internal", "/v1/messages"),
        ):
            launcher = "codex" if provider == "codex" else "claude"
            policy = {
                "schemaVersion": "1.0", "profileId": f"{provider}-q24",
                "profileFingerprint": "0" * 64, "provider": provider,
                "model": "synthetic-conformance-model", "upstreamScheme": "http",
                "upstreamHost": host, "upstreamPort": 8080, "upstreamPaths": [path],
                "httpMethod": "POST", "maxRequestBytes": 65536,
                "maxResponseBytes": 65536, "timeoutSeconds": 10,
                "sessionTtlSeconds": 300, "maxRequestsPerSession": 1,
                "implementationDigest": implementation,
                "networkPolicyFingerprint": self.policy_fingerprint,
                "credentialMode": "synthetic-emulator",
            }
            policy_digest = GatewayPolicy.fingerprint_manifest(policy)
            attest = json.loads(subprocess.check_output([
                "docker", "run", "--rm", "--network", "none",
                "--entrypoint", "/opt/sandiva/bin/exec01-runtime", self.image,
                "attest", launcher, "synthetic-conformance-model", implementation, policy_digest,
            ], text=True))
            fixed = (
                ("codex", "exec", "--json", "--ephemeral", "--strict-config",
                 "--dangerously-bypass-hook-trust", "--model", "synthetic-conformance-model",
                 "--sandbox", "read-only", "-")
                if provider == "codex" else
                ("claude", "--print", "--output-format", "stream-json", "--verbose", "--model",
                 "synthetic-conformance-model", "--permission-mode", "dontAsk", "--setting-sources",
                 "user", "--settings", "/opt/sandiva/claude/settings.json", "--strict-mcp-config",
                 "--mcp-config", "/opt/sandiva/claude/mcp.json", "--allowedTools",
                 "mcp__sandiva_execution_authority__sandiva_execute", "--disallowedTools",
                 "Bash,Read,Write,Edit,Glob,Grep,LS,NotebookEdit,WebFetch,WebSearch", "--no-session-persistence")
            )
            profile = ExecutorProfile(
                profile_id=policy["profileId"], provider=provider,
                runtime_name=f"{provider}-cli", runtime_version=attest["executableVersion"],
                model="synthetic-conformance-model", launcher_version=attest["launcherVersion"],
                executable_digest=attest["executableDigest"], fixed_argv=fixed, image=self.image,
                credential_mode="trusted-egress-gateway",
                gateway_endpoint="executor-gateway.sandiva.internal:8443",
                allowed_endpoints=("executor-gateway.sandiva.internal:8443",),
                runtime_wrapper_digest=attest["runtimeWrapperDigest"],
                gateway_implementation_digest=implementation,
                gateway_policy_digest=policy_digest,
            )
            policy["profileFingerprint"] = profile.fingerprint
            policy["gatewayPolicyFingerprint"] = policy_digest
            profiles[provider] = profile
            manifest[profile.fingerprint] = policy
        return profiles, manifest

    def _q24_request(self, profile, suffix):
        task = dispatch_task(
            taskId=f"Q24-{suffix}",
            baseRef=subprocess.check_output(
                ["git", "-C", str(self.workspace), "rev-parse", "HEAD"], text=True,
            ).strip(),
        )
        task["executorPolicy"]["approvedCommands"] = ["sh q16-build.sh"]
        task["dispatchPolicy"].update(
            executorProfile={"profileId": profile.profile_id, "profileFingerprint": profile.fingerprint},
            permittedFallbackProfiles=[], fallbackMode="NONE",
        )
        task = validate_dispatch_build_task(task)
        lease = type("Lease", (), {
            "attempt_id": f"attempt-q24-{suffix}", "lease_id": f"lease-q24-{suffix}",
            "fencing_token": 24,
        })()
        return normalize_execution_request(
            task, fingerprint(task), profile, lease,
            ResolvedExecutionArtifacts(PM_BYTES, SPEC_BYTES, AC_BYTES),
        )

    def _q24_issue(self, profile, request):
        return subprocess.check_output([
            "docker", "exec", self.gateway, "/opt/sandiva/bin/exec01-gateway", "issue",
            "--task-fingerprint", request.task_fingerprint,
            "--attempt-id", request.attempt_id,
            "--profile-fingerprint", profile.fingerprint,
        ], text=True).strip()

    def _q24_probe(self, token, path, body, repeat=1):
        script = (
            "import json,os,urllib.request,urllib.error\n"
            "out=[]\n"
            "for _ in range(int(os.environ['REPEAT'])):\n"
            " r=urllib.request.Request('http://executor-gateway.sandiva.internal:8443'+os.environ['PATH_Q'],"
            "data=os.environ['BODY'].encode(),headers={'Authorization':'Bearer '+os.environ['TOKEN'],"
            "'Content-Type':'application/json'},method='POST')\n"
            " try:\n  x=urllib.request.urlopen(r,timeout=5); out.append([x.status,x.read(65537).decode(errors='replace')])\n"
            " except urllib.error.HTTPError as e: out.append([e.code,e.read(1024).decode(errors='replace')])\n"
            "print(json.dumps(out))\n"
        )
        return json.loads(subprocess.check_output([
            "docker", "run", "--rm", "--network", self.network,
            "--env", f"TOKEN={token}", "--env", f"PATH_Q={path}",
            "--env", f"BODY={json.dumps(body,separators=(',',':'))}",
            "--env", f"REPEAT={repeat}", "--entrypoint", "python", self.gateway_image,
            "-c", script,
        ], text=True))

    @staticmethod
    def _q24_tamper_token(token, field, value):
        payload, signature = token.split(".", 1)
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        claims[field] = value
        changed = base64.urlsafe_b64encode(
            json.dumps(claims, sort_keys=True, separators=(",", ":")).encode()
        ).rstrip(b"=").decode()
        return changed + "." + signature

    def test_q24_full_runtime_gateway_proxy_and_upstream_emulator(self):
        # Replace the topology-only setUp peer with the reviewed gateway image.
        subprocess.run(["docker", "rm", "-f", self.gateway], check=True, stdout=subprocess.DEVNULL)
        upstream_network = f"{self.network}-upstream"
        upstream = f"{self.gateway}-upstream"
        credential = "Q24_PROVIDER_CREDENTIAL_SENTINEL_7c4f"
        subprocess.run(["docker", "network", "create", "--internal", upstream_network], check=True, stdout=subprocess.DEVNULL)
        try:
            profiles, manifest = self._q24_profiles_and_manifest()
            subprocess.run([
                "docker", "run", "-d", "--name", upstream, "--network", upstream_network,
                "--network-alias", "provider.test.internal",
                "--env", f"EXPECTED_PROVIDER_CREDENTIAL={credential}",
                "--entrypoint", "/opt/sandiva/bin/exec01-upstream-emulator", self.gateway_image,
            ], check=True, stdout=subprocess.DEVNULL)
            subprocess.run([
                "docker", "run", "-d", "--name", self.gateway, "--network", self.network,
                "--network-alias", "executor-gateway.sandiva.internal",
                "--label", f"sandiva.exec.gateway-policy={self.policy_fingerprint}",
                "--env", f"EXEC01_PROFILE_MANIFEST={json.dumps(manifest,separators=(',',':'))}",
                "--env", "EXEC01_SESSION_SIGNING_KEY=q24-gateway-signing-key-material-0001",
                "--env", "EXEC01_GATEWAY_RUNTIME_MODE=CODE_QA",
                "--env", f"OPENAI_API_KEY={credential}", "--env", f"ANTHROPIC_API_KEY={credential}",
                self.gateway_image, "serve",
            ], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["docker", "network", "connect", upstream_network, self.gateway], check=True)
            ready = False
            for _ in range(50):
                observed = subprocess.run([
                    "docker", "exec", self.gateway, "python", "-c",
                    "import socket; socket.create_connection(('127.0.0.1',8443),1).close(); socket.create_connection(('provider.test.internal',8080),1).close()",
                ], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if observed.returncode == 0:
                    ready = True
                    break
                time.sleep(0.1)
            self.assertTrue(ready, "source gateway or isolated upstream emulator did not become ready")
            binding = GatewayNetworkBinding(self.network, self.gateway, self.gateway_image, self.policy_fingerprint)
            controller = DockerExecutorGatewayController(binding, expected_runtime_mode="CODE_QA")
            observations, normalized_results = {}, {}
            for provider in ("codex", "claude-code"):
                profile = profiles[provider]
                request = self._q24_request(profile, provider.replace("-", ""))
                token = controller.prepare(profile, request)
                policy = ContainmentPolicy(
                    cpu_limit="1.0", memory_limit="128m", pids_limit=32,
                    workspace_limit_bytes=16*1024*1024, wall_time_seconds=30,
                    output_limit_bytes=65536, network_name=self.network,
                    allowed_endpoints=profile.allowed_endpoints,
                )
                job = DockerContainerJobRunner(
                    policy, network_attestor=DockerNetworkAttestor(binding),
                )
                runner = ContainerProviderRunner(policy, self.workspace.parent/"requests", runner=job)
                runner.bind_gateway_session(request, token)
                adapter = CodexExecutionAdapter(profile, runner) if provider == "codex" else ClaudeCodeExecutionAdapter(profile, runner)
                result = adapter.execute(request, self.workspace.as_posix())
                changes = PrepublicationInspector().inspect(str(self.workspace), request)
                self.assertEqual(result["disposition"], "EXECUTION_SUCCEEDED")
                self.assertIn("hermes-build-steward/README.md", changes.changed_paths)
                observations[provider] = (profile, request)
                normalized_results[provider] = result

            combined = json.dumps({"observations":observations, "results":normalized_results}, default=str) + subprocess.check_output(
                ["docker", "logs", self.gateway], text=True, stderr=subprocess.STDOUT,
            )
            for path in self.workspace.rglob("*"):
                if path.is_file(): combined += path.read_text(errors="replace")
            self.assertNotIn(credential, combined)

            # The executor network has no direct route or DNS membership for the upstream emulator.
            direct = subprocess.run([
                "docker", "run", "--rm", "--network", self.network, "--entrypoint", "python",
                self.gateway_image, "-c",
                "import urllib.request; urllib.request.urlopen('http://provider.test.internal:8080',timeout=2)",
            ], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.assertNotEqual(direct.returncode, 0)

            profile, request = observations["codex"]
            path = "/v1/responses"
            def issued(): return self._q24_issue(profile, request)
            normal = {"model": profile.model, "input": "probe"}
            replay = self._q24_probe(issued(), path, normal, repeat=2)
            self.assertEqual([item[0] for item in replay], [200, 403])
            cross_peer = issued()
            self.assertEqual(self._q24_probe(cross_peer, path, normal)[0][0], 200)
            self.assertEqual(self._q24_probe(cross_peer, path, normal)[0][0], 403)
            for token in (
                self._q24_tamper_token(issued(), "taskFingerprint", "f"*64),
                self._q24_tamper_token(issued(), "attemptId", "other-attempt"),
                self._q24_tamper_token(issued(), "profileFingerprint", "e"*64),
            ):
                self.assertEqual(self._q24_probe(token, path, normal)[0][0], 403)
            self.assertEqual(self._q24_probe(issued(), "/v1/messages", normal)[0][0], 403)
            for changed in (
                {**normal, "model": "executor-selected-model"},
                {**normal, "url": "https://attacker.invalid/collect"},
                {**normal, "testMode": "echo-success"},
                {**normal, "testMode": "echo-error"},
                {**normal, "testMode": "oversized-success"},
                {**normal, "testMode": "oversized-error"},
                {**normal, "testMode": "malformed"},
            ):
                observed = self._q24_probe(issued(), path, changed)
                self.assertEqual(observed[0][0], 403)
                self.assertNotIn(credential, observed[0][1])
        finally:
            subprocess.run(["docker", "rm", "-f", upstream], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["docker", "rm", "-f", self.gateway], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(["docker", "network", "rm", upstream_network], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__=="__main__": unittest.main()
