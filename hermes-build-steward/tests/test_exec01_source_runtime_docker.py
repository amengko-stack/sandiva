from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import uuid
from pathlib import Path

from helpers import AC_BYTES, PM_BYTES, SPEC_BYTES
from hermes_steward.contracts import fingerprint, validate_dispatch_build_task
from hermes_steward.execution_adapters import ClaudeCodeExecutionAdapter, CodexExecutionAdapter
from hermes_steward.execution_contracts import ExecutorProfile, ResolvedExecutionArtifacts, normalize_execution_request
from hermes_steward.execution_isolation import ContainerProviderRunner, ContainmentPolicy, DockerContainerJobRunner, DockerNetworkAttestor, GatewayNetworkBinding
from hermes_steward.prepublication import PrepublicationInspector
from test_execution_task_contract import dispatch_task


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("docker") and shutil.which("go"), "requires Linux Docker and Go")
class SourceControlledRuntimeDockerTests(unittest.TestCase):
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
    def _image_identity_fields(image):
        inspected = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0]
        return {
            "created": inspected.get("Created"),
            "rootfs": inspected.get("RootFS"),
            "history": inspected.get("History"),
            "config": inspected.get("Config"),
            "fileHashes": subprocess.check_output(
                [
                    "docker", "run", "--rm", "--entrypoint", "sha256sum", image,
                    "/opt/sandiva/bin/exec01-runtime", "/opt/sandiva/bin/codex", "/opt/sandiva/bin/claude",
                ],
                text=True,
            ).splitlines(),
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
            raise RuntimeError(f"gateway image build is not reproducible: {cls.gateway_image} != {repeated_gateway}")
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

    def _profile_request(self, provider):
        launcher="codex" if provider=="codex" else "claude"
        attest=json.loads(subprocess.check_output(["docker","run","--rm","--network","none","--entrypoint","/opt/sandiva/bin/exec01-runtime",self.image,"attest",launcher,"synthetic-conformance-model","a"*64,self.policy_fingerprint],text=True))
        fixed=("codex","exec","--json","--ephemeral","--ignore-user-config","--model","synthetic-conformance-model","--sandbox","danger-full-access","-") if provider=="codex" else ("claude","--print","--output-format","stream-json","--verbose","--model","synthetic-conformance-model","--permission-mode","bypassPermissions")
        profile=ExecutorProfile(profile_id=f"{provider}-source-runtime",provider=provider,runtime_name=f"{provider}-cli",runtime_version=attest["executableVersion"],model="synthetic-conformance-model",launcher_version=attest["launcherVersion"],executable_digest=attest["executableDigest"],fixed_argv=fixed,image=self.image,credential_mode="trusted-egress-gateway",gateway_endpoint="executor-gateway.sandiva.internal:8443",allowed_endpoints=("executor-gateway.sandiva.internal:8443",),runtime_wrapper_digest=attest["runtimeWrapperDigest"],gateway_implementation_digest="a"*64,gateway_policy_digest=self.policy_fingerprint)
        task=dispatch_task(taskId=f"Q{provider.upper().replace('-','')}",baseRef=subprocess.check_output(["git","-C",str(self.workspace),"rev-parse","HEAD"],text=True).strip())
        task["executorPolicy"]["approvedCommands"]=["sh q16-build.sh"]
        task["dispatchPolicy"].update(executorProfile={"profileId":profile.profile_id,"profileFingerprint":profile.fingerprint},permittedFallbackProfiles=[],fallbackMode="NONE")
        task=validate_dispatch_build_task(task)
        lease=type("Lease",(),{"attempt_id":f"attempt-{provider}","lease_id":f"lease-{provider}","fencing_token":1})()
        request=normalize_execution_request(task,fingerprint(task),profile,lease,ResolvedExecutionArtifacts(PM_BYTES,SPEC_BYTES,AC_BYTES))
        return profile,request

    def _run(self, provider):
        profile,request=self._profile_request(provider)
        policy=ContainmentPolicy(cpu_limit="1.0",memory_limit="128m",pids_limit=32,workspace_limit_bytes=16*1024*1024,wall_time_seconds=30,output_limit_bytes=65536,network_name=self.network,allowed_endpoints=profile.allowed_endpoints)
        job=DockerContainerJobRunner(policy,network_attestor=DockerNetworkAttestor(GatewayNetworkBinding(self.network,self.gateway,self.image,self.policy_fingerprint)))
        runner=ContainerProviderRunner(policy,self.workspace.parent/"requests",runner=job)
        adapter=CodexExecutionAdapter(profile,runner) if provider=="codex" else ClaudeCodeExecutionAdapter(profile,runner)
        result=adapter.execute(request,self.workspace.as_posix()); changes=PrepublicationInspector().inspect(str(self.workspace),request)
        return request,result,changes

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
        manifest={
            "1"*64:{"provider":"codex","model":"codex-model","profileId":"codex-q3","policyFingerprint":"3"*64,"implementationDigest":implementation,"upstreamUrl":"https://api.openai.com/v1/responses"},
            "2"*64:{"provider":"claude-code","model":"claude-model","profileId":"claude-q3","policyFingerprint":"3"*64,"implementationDigest":implementation,"upstreamUrl":"https://api.anthropic.com/v1/messages"},
        }
        environment=["--env",f"EXEC01_PROFILE_MANIFEST={json.dumps(manifest,separators=(',',':'))}","--env","EXEC01_SESSION_SIGNING_KEY=q3-source-gateway-signing-key-material"]
        health=json.loads(subprocess.check_output(["docker","run","--rm",*environment,self.gateway_image,"health"],text=True))
        self.assertEqual(set(health["profiles"]),set(manifest))
        token=subprocess.check_output(["docker","run","--rm",*environment,self.gateway_image,"issue","--task-fingerprint","4"*64,"--attempt-id","attempt-q3","--profile-fingerprint","1"*64],text=True).strip()
        self.assertGreater(len(token),64)
        self.assertNotIn("OPENAI",token)


if __name__=="__main__": unittest.main()
