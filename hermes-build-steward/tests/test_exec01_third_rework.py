from __future__ import annotations

import copy
import io
import json
import unittest
import shutil
import os
import subprocess
import sys
import tempfile
import uuid
from dataclasses import replace
from pathlib import Path
from urllib.error import HTTPError

from hermes_steward.execution_gateway_service import (
    BoundProviderProxy,
    GatewayApplication,
    GatewayPolicy,
    GatewaySessionCodec,
    GatewayServiceDenied,
)
from test_execution_adapters import profile
import test_exec01_second_rework as second_rework
from test_execution_task_contract import dispatch_task
from hermes_steward.execution_runtime import ProductionExecutionService
from hermes_steward.execution_runtime import BoundArtifactResolver
from hermes_steward.execution_contracts import (
    ObservedExecutorIdentity, ResolvedExecutionArtifacts, normalize_execution_request,
)
from hermes_steward.execution_adapters import CodexExecutionAdapter, ClaudeCodeExecutionAdapter
from hermes_steward.execution_coordinator import (
    ExecutionRecord, ExecutionStage, build_execution_audit_record, execution_record_to_dict,
)
from hermes_steward.execution_publisher import (
    PublicationRecord, _encode_metadata, deterministic_branch, deterministic_pr_identity,
)
from hermes_steward.prepublication import ChangeSet
from hermes_steward.store import InMemoryStateStore
from hermes_steward.contracts import fingerprint, validate_dispatch_build_task
from qualification.run_exec01_vm_qualification import (
    DurableQualificationEvidenceCollector, REQUIRED_CHECKS, TrustedGitHubQualificationReadPath,
)
from helpers import AC_BYTES, PM_BYTES, SPEC_BYTES


def gateway_manifest(provider: str = "codex") -> tuple[str, dict, object]:
    selected = profile(provider)
    value = {
        "schemaVersion": "1.0",
        "profileId": selected.profile_id,
        "profileFingerprint": "0" * 64,
        "provider": provider,
        "model": selected.model,
        "upstreamScheme": "https",
        "upstreamHost": "api.openai.com" if provider == "codex" else "api.anthropic.com",
        "upstreamPort": 443,
        "upstreamPaths": ["/v1/responses" if provider == "codex" else "/v1/messages"],
        "httpMethod": "POST",
        "maxRequestBytes": 65536,
        "maxResponseBytes": 65536,
        "timeoutSeconds": 30,
        "sessionTtlSeconds": 300,
        "maxRequestsPerSession": 1,
        "implementationDigest": selected.gateway_implementation_digest,
        "networkPolicyFingerprint": "7" * 64,
        "credentialMode": "trusted-header-injection",
    }
    value["gatewayPolicyFingerprint"] = GatewayPolicy.fingerprint_manifest(value)
    selected = replace(selected, gateway_policy_digest=value["gatewayPolicyFingerprint"])
    value["profileFingerprint"] = selected.fingerprint
    return selected.fingerprint, value, selected


class ThirdReworkGatewayTests(unittest.TestCase):
    def test_q21_gateway_policy_is_canonical_closed_and_profile_bound(self):
        key, manifest, selected = gateway_manifest()
        policy = GatewayPolicy.from_manifest(key, manifest)
        self.assertEqual(policy.policy_fingerprint, manifest["gatewayPolicyFingerprint"])
        self.assertEqual(policy.canonical_identity(), {
            k: v for k, v in manifest.items() if k != "gatewayPolicyFingerprint"
        })
        policy.assert_profile(selected)

        mutations = {
            "manifest key": ("0" * 64, {}),
            "provider": (key, {"provider": "claude-code"}),
            "model": (key, {"model": "attacker-model"}),
            "profile id": (key, {"profileId": "other-profile"}),
            "implementation": (key, {"implementationDigest": "0" * 64}),
            "request limit": (key, {"maxRequestBytes": 65535}),
            "forged fingerprint": (key, {"gatewayPolicyFingerprint": "0" * 64}),
            "unknown field": (key, {"unexpected": True}),
        }
        for label, (observed_key, changed) in mutations.items():
            candidate = {**manifest, **changed}
            if "gatewayPolicyFingerprint" not in changed:
                candidate["gatewayPolicyFingerprint"] = GatewayPolicy.fingerprint_manifest(candidate)
            with self.subTest(label=label), self.assertRaises((ValueError, GatewayServiceDenied)):
                observed = GatewayPolicy.from_manifest(observed_key, candidate)
                observed.assert_profile(selected)

    def test_q22_arbitrary_upstream_query_fragment_and_redirect_are_denied(self):
        key, manifest, _ = gateway_manifest()
        for label, changed in {
            "host": {"upstreamHost": "attacker.example"},
            "path": {"upstreamPaths": ["/v1/responses/../../metadata"]},
            "query": {"upstreamPaths": ["/v1/responses?target=attacker"]},
            "fragment": {"upstreamPaths": ["/v1/responses#attacker"]},
            "scheme": {"upstreamScheme": "ftp"},
        }.items():
            candidate = {**manifest, **changed}
            candidate["gatewayPolicyFingerprint"] = GatewayPolicy.fingerprint_manifest(candidate)
            with self.subTest(label=label), self.assertRaises(ValueError):
                GatewayPolicy.from_manifest(key, candidate)

        class Redirect:
            status = 302
            headers = {"Location": "https://attacker.example/steal"}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size=-1): return b""
            def geturl(self): return "https://attacker.example/steal"

        policy = GatewayPolicy.from_manifest(key, manifest)
        proxy = BoundProviderProxy(policy, lambda: "provider-secret", opener=lambda *args, **kwargs: Redirect())
        with self.assertRaisesRegex(GatewayServiceDenied, "provider response rejected"):
            proxy.forward({"model": policy.model, "input": "bounded"})

    def test_q23_provider_credential_reflection_is_discarded_for_success_and_error(self):
        key, manifest, _ = gateway_manifest()
        credential = "Q23-PROVIDER-CREDENTIAL-SENTINEL"
        policy = GatewayPolicy.from_manifest(key, manifest)

        class Response:
            status = 200
            headers = {"Content-Type": "application/json"}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size=-1): return json.dumps({"echo": credential}).encode()
            def geturl(self): return policy.upstream_url

        proxy = BoundProviderProxy(policy, lambda: credential, opener=lambda *args, **kwargs: Response())
        application = GatewayApplication(policy, GatewaySessionCodec(b"q23-session-signing-key-material-000", clock=lambda: 1), proxy)
        token = application.codec.issue(
            task_fingerprint="8"*64, attempt_id="attempt-q23",
            profile_fingerprint=policy.profile_fingerprint, ttl=300,
        )
        with self.assertRaisesRegex(GatewayServiceDenied, "provider response rejected") as caught:
            application.execute(token, {"model": policy.model})
        self.assertNotIn(credential, str(caught.exception))
        self.assertNotIn(credential, json.dumps(application.audit))
        self.assertEqual(application.audit[0]["classification"], "POLICY_DENIED")

        error = HTTPError(policy.upstream_url, 401, "denied", {}, io.BytesIO(
            json.dumps({"authorization": f"Bearer {credential}"}).encode()
        ))
        proxy = BoundProviderProxy(policy, lambda: credential, opener=lambda *args, **kwargs: (_ for _ in ()).throw(error))
        with self.assertRaisesRegex(GatewayServiceDenied, "provider response rejected") as caught:
            proxy.forward({"model": policy.model})
        self.assertNotIn(credential, str(caught.exception))


class ThirdReworkFallbackTests(unittest.TestCase):
    def _crashed_service(self, root: Path, crash_point: str = "FALLBACK_PENDING"):
        codex, claude = profile("codex"), profile("claude-code")
        claude = replace(claude, allowed_endpoints=codex.allowed_endpoints)
        task = dispatch_task(taskId="Q25", retryPolicy={"maxAttempts": 3, "backoffSeconds": 0})
        task["dispatchPolicy"].update(
            executorProfile={"profileId": codex.profile_id, "profileFingerprint": codex.fingerprint},
            permittedFallbackProfiles=[{"profileId": claude.profile_id, "profileFingerprint": claude.fingerprint}],
            fallbackMode="ORDERED",
        )
        class PrimaryUnavailable:
            calls = []
            def invoke(self, selected, request, workspace):
                self.calls.append((selected.profile_id, request.attempt_id))
                return {
                    "protocol":"codex-exec-jsonl-v1", "status":"failed",
                    "started_at":"2026-09-07T00:00:00Z", "completed_at":"2026-09-07T00:00:01Z",
                    "commands":[], "tests":[], "log_refs":[], "error_type":"provider_unavailable",
                }
        seen = {}
        def crash(point, record):
            del record
            seen[point] = seen.get(point, 0) + 1
            occurrence = 2 if crash_point in {"BEFORE_WORKSPACE_CREATE", "AFTER_WORKSPACE_CREATE"} else 1
            if point == crash_point and seen[point] == occurrence:
                raise RuntimeError(f"crash-at-{crash_point.lower().replace('_', '-')}")
        runner = PrimaryUnavailable()
        service, hermes = second_rework.SecondReworkFocusedTests()._service(
            root, task, {"codex":codex, "claude-code":claude}, runner, transition_hook=crash,
        )
        with self.assertRaisesRegex(RuntimeError, crash_point.lower().replace("_", "-")):
            service.dispatch(task)
        return task, codex, claude, service, hermes, runner

    def test_q25_crash_after_primary_unavailability_resumes_exact_durable_fallback(self):
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]
        root.mkdir(parents=True)
        try:
            task, codex, claude, crashed, hermes, primary = self._crashed_service(root)
            durable = hermes.store.get(f"dev.exec01:{task['taskId']}:{task['taskVersion']}").value
            self.assertIsNone(durable.active_lease)
            self.assertEqual(durable.unavailable_profile_fingerprints, [codex.fingerprint])
            self.assertEqual(durable.pending_fallback_profile_fingerprint, claude.fingerprint)
            self.assertEqual(durable.primary_failure_attempt_id, primary.calls[0][1])

            class Fallback:
                calls = []
                def invoke(self, selected, request, workspace):
                    self.calls.append((selected.profile_id, request.attempt_id, json.loads(request.fallback_context_json)))
                    (Path(workspace) / "hermes-build-steward" / "README.md").write_text("fallback\n")
                    return {
                        "protocol":"claude-code-stream-json-v1", "stop_reason":"end_turn",
                        "startedAt":"2026-09-07T00:00:02Z", "completedAt":"2026-09-07T00:00:03Z",
                        "commandsExecuted":[], "testOutcomes":[], "evidenceReferences":[],
                    }
            fallback = Fallback()
            restarted = ProductionExecutionService(
                crashed.config, hermes, crashed.execution_store, crashed.result_sink, fallback,
                crashed.publisher, crashed.artifact_resolver,
            )
            result = restarted.resume(task)
            self.assertEqual(result.stage, ExecutionStage.RESULT_PERSISTED)
            self.assertEqual([item[0] for item in fallback.calls], [claude.profile_id])
            self.assertEqual(fallback.calls[0][2]["primaryAttemptId"], primary.calls[0][1])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_q26_duplicate_dispatch_after_fallback_crash_never_replays_primary_or_competes(self):
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]
        root.mkdir(parents=True)
        try:
            task, _, claude, crashed, hermes, primary = self._crashed_service(root)
            class Fallback:
                calls = []
                def invoke(self, selected, request, workspace):
                    self.calls.append((selected.profile_id, request.attempt_id))
                    (Path(workspace) / "hermes-build-steward" / "README.md").write_text("fallback\n")
                    return {"protocol":"claude-code-stream-json-v1", "stop_reason":"end_turn", "startedAt":"2026-09-07T00:00:02Z", "completedAt":"2026-09-07T00:00:03Z", "commandsExecuted":[], "testOutcomes":[], "evidenceReferences":[]}
            fallback = Fallback()
            restarted = ProductionExecutionService(
                crashed.config, hermes, crashed.execution_store, crashed.result_sink, fallback,
                crashed.publisher, crashed.artifact_resolver,
            )
            first = restarted.dispatch(task)
            second = restarted.dispatch(task)
            self.assertEqual(first.attempt_id, second.attempt_id)
            self.assertEqual(fallback.calls, [(claude.profile_id, first.attempt_id)])
            self.assertEqual(len(primary.calls), 1)
            durable = hermes.store.get(f"dev.exec01:{task['taskId']}:{task['taskVersion']}").value
            fallback_events = [item for item in durable.audit if item["event"] == "FALLBACK_ATTEMPT_CLAIMED"]
            self.assertEqual(len(fallback_events), 1)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_fallback_state_is_restart_safe_at_every_required_crash_boundary(self):
        points = (
            "BEFORE_RECORD_UNAVAILABILITY", "UNAVAILABILITY_RECORDED", "FALLBACK_PENDING",
            "BEFORE_FALLBACK_LEASE_CLAIM", "AFTER_FALLBACK_LEASE_CLAIM",
            "BEFORE_WORKSPACE_CREATE", "AFTER_WORKSPACE_CREATE",
        )
        for point in points:
            root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]
            root.mkdir(parents=True)
            try:
                task, codex, claude, crashed, hermes, primary = self._crashed_service(root, point)
                class RecoveryRunner:
                    calls = []
                    def invoke(self, selected, request, workspace):
                        self.calls.append((selected.profile_id, request.attempt_id))
                        if selected.provider == "codex":
                            return {
                                "protocol":"codex-exec-jsonl-v1", "status":"failed",
                                "started_at":"2026-09-07T00:00:00Z", "completed_at":"2026-09-07T00:00:01Z",
                                "commands":[], "tests":[], "log_refs":[], "error_type":"provider_unavailable",
                            }
                        (Path(workspace) / "hermes-build-steward" / "README.md").write_text("fallback\n")
                        return {
                            "protocol":"claude-code-stream-json-v1", "stop_reason":"end_turn",
                            "startedAt":"2026-09-07T00:00:02Z", "completedAt":"2026-09-07T00:00:03Z",
                            "commandsExecuted":[], "testOutcomes":[], "evidenceReferences":[],
                        }
                recovery = RecoveryRunner()
                restarted = ProductionExecutionService(
                    crashed.config, hermes, crashed.execution_store, crashed.result_sink, recovery,
                    crashed.publisher, crashed.artifact_resolver,
                )
                result = restarted.resume(task)
                self.assertEqual(result.stage, ExecutionStage.RESULT_PERSISTED, point)
                self.assertEqual(result.execution_result["executorProfile"]["profileId"], claude.profile_id, point)
                durable = hermes.store.get(f"dev.exec01:{task['taskId']}:{task['taskVersion']}").value
                self.assertEqual(durable.unavailable_profile_fingerprints, [codex.fingerprint], point)
                self.assertEqual(len(primary.calls), 1, point)
                self.assertLessEqual(sum(1 for call in recovery.calls if call[0] == codex.profile_id), 0, point)
                fallback_events = [item for item in durable.audit if item["event"] == "FALLBACK_ATTEMPT_CLAIMED"]
                self.assertEqual(len(fallback_events), 1, point)
            finally:
                shutil.rmtree(root, ignore_errors=True)

    def test_q27_unknown_runtime_failure_is_internal_and_never_authorizes_fallback(self):
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]
        root.mkdir(parents=True)
        try:
            codex, claude = profile("codex"), profile("claude-code")
            claude = replace(claude, allowed_endpoints=codex.allowed_endpoints)
            task = dispatch_task(taskId="Q27", retryPolicy={"maxAttempts": 3, "backoffSeconds": 0})
            task["dispatchPolicy"].update(
                executorProfile={"profileId": codex.profile_id, "profileFingerprint": codex.fingerprint},
                permittedFallbackProfiles=[{"profileId": claude.profile_id, "profileFingerprint": claude.fingerprint}],
                fallbackMode="ORDERED",
            )
            class UnknownFailure:
                calls = []
                def invoke(self, selected, request, workspace):
                    del workspace
                    self.calls.append((selected.profile_id, request.attempt_id))
                    return {
                        "protocol":"codex-exec-jsonl-v1", "status":"failed",
                        "started_at":"2026-09-07T00:00:00Z", "completed_at":"2026-09-07T00:00:01Z",
                        "commands":[], "tests":[], "log_refs":[], "error_type":"internal_error",
                    }
            runner = UnknownFailure()
            service, hermes = second_rework.SecondReworkFocusedTests()._service(
                root, task, {"codex":codex, "claude-code":claude}, runner,
            )
            result = service.dispatch(task)
            self.assertEqual(result.failure_classification, "INTERNAL_ERROR")
            self.assertEqual(len(runner.calls), 1)
            durable = hermes.store.get(f"dev.exec01:{task['taskId']}:{task['taskVersion']}").value
            self.assertEqual(durable.unavailable_profile_fingerprints, [])
            self.assertIsNone(durable.pending_fallback_profile_fingerprint)
        finally:
            shutil.rmtree(root, ignore_errors=True)


def authoritative_collector_fixture(*, mutate_result=None, duplicate_kind=None, mutate_github_metadata=None):
    profiles = {"codex": profile("codex"), "claude-code": profile("claude-code")}
    task = dispatch_task(taskId="Q17-QUALIFICATION")
    task["dispatchPolicy"].update(
        executorProfile={"profileId":profiles["codex"].profile_id,"profileFingerprint":profiles["codex"].fingerprint},
        permittedFallbackProfiles=[{"profileId":profiles["claude-code"].profile_id,"profileFingerprint":profiles["claude-code"].fingerprint}],
        fallbackMode="ORDERED",
    )
    task = validate_dispatch_build_task(task)
    task_fingerprint = fingerprint(task)
    task_store, execution_store, result_store = InMemoryStateStore(), InMemoryStateStore(), InMemoryStateStore()
    probe_store, check_store, hermes_store = InMemoryStateStore(), InMemoryStateStore(), InMemoryStateStore()
    task_store.create("task", task)
    github = {}
    for number, (provider, selected) in enumerate(profiles.items(), 1):
        lease = type("Lease", (), {
            "attempt_id":f"attempt-{provider}", "lease_id":f"lease-{provider}", "fencing_token":number,
        })()
        request = normalize_execution_request(
            task, task_fingerprint, selected, lease, ResolvedExecutionArtifacts(PM_BYTES, SPEC_BYTES, AC_BYTES),
            ObservedExecutorIdentity.from_profile(selected),
            None if provider == "codex" else {
                "primaryAttemptId":"attempt-codex", "unavailableProfileId":profiles["codex"].profile_id,
                "failureClassification":"PROVIDER_UNAVAILABLE",
            },
        )
        raw = (
            {"protocol":"codex-exec-jsonl-v1","status":"completed","started_at":"2026-09-07T00:00:00Z","completed_at":"2026-09-07T00:00:01Z","commands":[],"tests":[],"log_refs":[]}
            if provider == "codex" else
            {"protocol":"claude-code-stream-json-v1","stop_reason":"end_turn","startedAt":"2026-09-07T00:00:02Z","completedAt":"2026-09-07T00:00:03Z","commandsExecuted":[],"testOutcomes":[],"evidenceReferences":[]}
        )
        adapter = CodexExecutionAdapter(selected, second_rework.SyntheticRunner(provider, raw)) if provider == "codex" else ClaudeCodeExecutionAdapter(selected, second_rework.SyntheticRunner(provider, raw))
        result = adapter.execute(request, "/workspace")
        changes = ChangeSet(("hermes-build-steward/README.md",), ("a" if provider == "codex" else "b")*64, 8, (), ())
        branch, pr_identity = deterministic_branch(request), deterministic_pr_identity(request)
        commit = str(number) * 40
        pr_number = 81 if duplicate_kind == "pr" else 80 + number
        draft_pr = {"number":pr_number,"url":f"https://github.com/amengko-stack/sandiva/pull/{pr_number}","isDraft":True}
        result.update(changedPaths=list(changes.changed_paths),patchDigest=changes.patch_digest,branch=branch,commitSha=commit,draftPr=draft_pr)
        if mutate_result is not None and provider == "codex":
            mutate_result(result)
        publication = PublicationRecord(branch, commit, draft_pr, pr_identity)
        execution = ExecutionRecord(
            identity=f"exec:{task_fingerprint}:{lease.attempt_id}", task_fingerprint=task_fingerprint,
            attempt_id=lease.attempt_id, stage=ExecutionStage.RESULT_PERSISTED, revision=7,
            execution_result=copy.deepcopy(result), change_set=changes, publication=publication,
            audit=tuple(stage.value for stage in (
                ExecutionStage.CREATED, ExecutionStage.WORKSPACE_READY, ExecutionStage.EXECUTOR_STARTED,
                ExecutionStage.IMPLEMENTED, ExecutionStage.CHANGESET_APPROVED, ExecutionStage.PUBLISHED,
                ExecutionStage.RESULT_PERSISTED,
            )),
        )
        audit = build_execution_audit_record(request, execution)
        execution_store.create(f"execution-{provider}", execution)
        result_store.create(f"result-{provider}", result)
        result_store.create(f"audit-{provider}", audit)
        if duplicate_kind == "execution" and provider == "codex": execution_store.create("duplicate-execution", execution)
        if duplicate_kind == "result" and provider == "codex": result_store.create("duplicate-result", result)
        if duplicate_kind == "audit" and provider == "codex": result_store.create("duplicate-audit", audit)
        probe = {"provider":provider,"attemptId":lease.attempt_id,"taskFingerprint":task_fingerprint,"profileFingerprint":selected.fingerprint,"origin":"trusted-runtime-probe","evidenceFingerprint":("c" if provider == "codex" else "d")*64}
        probe_store.create(f"probe-{provider}", probe)
        if duplicate_kind == "probe" and provider == "codex": probe_store.create("duplicate-probe", probe)
        metadata = {
            "taskFingerprint":task_fingerprint,"baseSha":task["baseRef"],"patchDigest":changes.patch_digest,
            "attemptId":lease.attempt_id,"leaseId":lease.lease_id,"fencingToken":lease.fencing_token,
            "prIdentity":pr_identity,"specificationHash":task["specificationHash"],
            "acceptanceContractHash":task["acceptanceContractHash"],
            "executorProfileFingerprint":selected.fingerprint,
            "branch":branch,
        }
        if mutate_github_metadata is not None and provider == "codex": mutate_github_metadata(metadata)
        marker = "message\n\nSandiva-Exec-Metadata: " + _encode_metadata(metadata)
        pr_marker = "message\n\nSandiva-Exec-Metadata: " + _encode_metadata({**metadata, "commitSha":commit})
        github[("branch",branch)]={"object":{"sha":commit}}
        github[("commit",commit)]={"sha":commit,"commit":{"message":marker}}
        github[("pr",branch)]=[{"number":pr_number,"head":{"ref":branch,"sha":commit},"base":{"ref":"main"},"state":"open","draft":True,"merged":False,"body":pr_marker}]
        github[("checks",commit)]={"check_runs":[{"id":number,"name":"build","head_sha":commit,"conclusion":"success"}]}
    for index, name in enumerate(REQUIRED_CHECKS):
        check_store.create(str(index),{"taskFingerprint":task_fingerprint,"name":name,"origin":"trusted-runtime-probe","evidenceFingerprint":"e"*64})
    hermes_store.create("pass",{"origin":"trusted-hermes-independent","evidenceIdentity":"hermes://q17/pass","taskFingerprint":task_fingerprint,"disposition":"PASS"})
    class Transport:
        def __init__(self): self.github = github
        def request(self, method, path, body=None):
            del method, body
            from urllib.parse import unquote
            if path.startswith("/git/ref/heads/"): return 200, self.github[("branch",unquote(path.rsplit("/",1)[-1]))]
            if path.startswith("/pulls?"): return 200, self.github[("pr",unquote(path.split(":",1)[1]))]
            if path.endswith("/check-runs"): return 200, self.github[("checks",path.split("/")[2])]
            if path.startswith("/commits/"): return 200, self.github[("commit",path.split("/")[2])]
            return 404, {}
    resolver = BoundArtifactResolver(
        pm_ref=task["originatingPmInstructionRef"],pm_instruction=PM_BYTES,
        specification_ref=task["specificationRef"],specification=SPEC_BYTES,
        acceptance_contract_ref=task["acceptanceContractRef"],acceptance_contract=AC_BYTES,
    )
    collector = DurableQualificationEvidenceCollector(
        task_store=task_store,task_key="task",execution_store=execution_store,
        result_store=result_store,probe_store=probe_store,check_store=check_store,
        hermes_evidence_store=hermes_store,github_reader=TrustedGitHubQualificationReadPath("amengko-stack/sandiva",Transport()),
        implementation_head_loader=lambda:"f"*40,profiles=profiles,artifact_resolver=resolver,
    )
    return collector, profiles


class ThirdReworkQualificationTests(unittest.TestCase):
    @staticmethod
    def _write_store(path: Path, values, encoder=lambda value: value, *, first_key=None):
        records = [
            {"key": first_key if index == 0 and first_key is not None else f"record-{index}", "value": encoder(item.value)}
            for index, item in enumerate(values)
        ]
        path.write_text(json.dumps({"records":records}), encoding="utf-8")

    def test_q17_qualification_cli_collect_and_verify_use_concrete_authoritative_resolver(self):
        collector, profiles = authoritative_collector_fixture()
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]
        root.mkdir(parents=True)
        try:
            profiles_path=root/"profiles.json"; profiles_path.write_text(json.dumps({k:v.as_dict() for k,v in profiles.items()}))
            key_path=root/"attestation.key"; key_path.write_bytes(b"q17-authoritative-attestation-key-material")
            key_path.chmod(0o600)
            (root/"pm.md").write_bytes(PM_BYTES); (root/"spec.md").write_bytes(SPEC_BYTES); (root/"contract.md").write_bytes(AC_BYTES)
            self._write_store(root/"task.json", [collector.task_store.get("task")], first_key="task")
            self._write_store(root/"executions.json", collector.execution_store.list_records(), execution_record_to_dict)
            self._write_store(root/"results.json", collector.result_store.list_records())
            self._write_store(root/"probes.json", collector.probe_store.list_records())
            self._write_store(root/"checks.json", collector.check_store.list_records())
            self._write_store(root/"hermes.json", collector.hermes_evidence_store.list_records())
            github = collector.github_reader.transport.github
            github_path=root/"github.json"
            github_path.write_text(json.dumps({
                "branches":{key[1]:value for key,value in github.items() if key[0]=="branch"},
                "commits":{key[1]:value for key,value in github.items() if key[0]=="commit"},
                "pullRequests":{key[1]:value for key,value in github.items() if key[0]=="pr"},
                "checks":{key[1]:value for key,value in github.items() if key[0]=="checks"},
            }))
            config={
                "schemaVersion":"1.0","classification":"synthetic-code-qa","profilesFile":str(profiles_path),
                "attestationKeyFile":str(key_path),"implementationRepositoryPath":str(Path.cwd().parent),
                "taskStore":{"kind":"file","path":str(root/"task.json"),"key":"task"},
                "executionStore":{"kind":"file","path":str(root/"executions.json")},
                "resultStore":{"kind":"file","path":str(root/"results.json")},
                "probeStore":{"kind":"file","path":str(root/"probes.json")},
                "checkStore":{"kind":"file","path":str(root/"checks.json")},
                "hermesEvidenceStore":{"kind":"file","path":str(root/"hermes.json")},
                "artifacts":{"pmInstructionFile":str(root/"pm.md"),"specificationFile":str(root/"spec.md"),"acceptanceContractFile":str(root/"contract.md")},
                "githubReadback":{"kind":"file","repository":"amengko-stack/sandiva","path":str(github_path)},
            }
            config_path=root/"config.json"; config_path.write_text(json.dumps(config))
            evidence_path=root/"evidence.json"
            command=[sys.executable,"qualification/run_exec01_vm_qualification.py"]
            environment={**os.environ,"PYTHONPATH":"src"}
            collected=subprocess.run([*command,"collect","--config",str(config_path),"--output",str(evidence_path)],text=True,capture_output=True,env=environment)
            self.assertEqual(collected.returncode,0,collected.stderr)
            self.assertTrue(evidence_path.is_file())
            verified=subprocess.run([*command,"verify","--config",str(config_path),"--evidence",str(evidence_path)],text=True,capture_output=True,env=environment)
            self.assertEqual(verified.returncode,0,verified.stderr)
            self.assertEqual(json.loads(verified.stdout)["status"],"QUALIFIED")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_q18_qualification_verify_without_configuration_never_prints_qualified(self):
        completed=subprocess.run(
            [sys.executable,"qualification/run_exec01_vm_qualification.py","verify","--evidence","missing.json"],
            text=True,capture_output=True,env={**os.environ,"PYTHONPATH":"src"},
        )
        self.assertNotEqual(completed.returncode,0)
        self.assertNotIn("QUALIFIED",completed.stdout)

    def test_q19_incomplete_full_schema_normalized_result_is_rejected(self):
        collector, _ = authoritative_collector_fixture(mutate_result=lambda value: value.pop("testOutcomes"))
        with self.assertRaisesRegex((SystemExit, ValueError), "result"):
            collector.resolve()

    def test_q20_duplicate_execution_result_audit_or_probe_is_rejected_before_indexing(self):
        for kind in ("execution", "result", "audit", "probe", "pr"):
            collector, _ = authoritative_collector_fixture(duplicate_kind=kind)
            with self.subTest(kind=kind), self.assertRaisesRegex(SystemExit, "duplicate"):
                collector.resolve()

    def test_task_bound_github_commit_and_pr_metadata_are_independently_validated(self):
        collector, _ = authoritative_collector_fixture()
        self.assertEqual(len(collector.resolve()["executionRecords"]), 2)
        for field in ("taskFingerprint","attemptId","leaseId","fencingToken","executorProfileFingerprint","baseSha","patchDigest","specificationHash","acceptanceContractHash","prIdentity","branch"):
            collector, _ = authoritative_collector_fixture(mutate_github_metadata=lambda value, key=field: value.__setitem__(key, "0"*64 if key not in {"fencingToken"} else 999))
            with self.subTest(field=field), self.assertRaisesRegex(SystemExit, "metadata"):
                collector.resolve()

if __name__ == "__main__":
    unittest.main()
