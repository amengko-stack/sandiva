from __future__ import annotations

import copy
import hashlib
import io
import unittest
import shutil
import subprocess
import uuid
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError

from helpers import AC_BYTES, SPEC_BYTES
from hermes_steward.contracts import fingerprint, validate_dispatch_build_task
from hermes_steward.execution_adapters import CodexExecutionAdapter
from hermes_steward.execution_contracts import (
    ExecutionContractError,
    ResolvedExecutionArtifacts,
    normalize_execution_request,
    ObservedExecutorIdentity,
)
from hermes_steward.config import RuntimeConfig
from hermes_steward.coordinator import Coordinator
from hermes_steward.execution_coordinator import ExecutionStage, InMemoryExecutionRecordStore
from hermes_steward.execution_gateway_service import (
    BoundProviderProxy, GatewayApplication, GatewayControlPlane, GatewayPolicy, GatewaySessionCodec,
)
from hermes_steward.execution_isolation import ContainmentPolicy, GatewayNetworkBinding
from hermes_steward.execution_runtime import (
    BoundArtifactResolver, ExecutionRuntimeConfig, ProductionExecutionService,
)
from hermes_steward.store import InMemoryStateStore
from hermes_steward.execution_gateway import UrlLibProviderHTTPTransport
from hermes_steward.execution_publisher import PublicationConflict, TrustedGitHubPublisher
from qualification.run_exec01_vm_qualification import (
    CONTRACT_SHA256, REQUIRED_CHECKS, DurableQualificationEvidenceCollector,
    TrustedGitHubQualificationReadPath, sign_evidence, verify_evidence,
)
from test_execution_adapters import SyntheticRunner, profile, request_for
from test_execution_publisher import InMemoryGitHubGateway, changes
from test_execution_recovery import ResultSink
from test_exec01_runtime_composition import _source_repository
from test_execution_task_contract import dispatch_task


PM_BYTES = b"Approved PM build instruction\n"


def resolved() -> ResolvedExecutionArtifacts:
    return ResolvedExecutionArtifacts(
        pm_instruction=PM_BYTES,
        specification=SPEC_BYTES,
        acceptance_contract=AC_BYTES,
    )


def gateway_policy_for(selected, *, max_response_bytes=4 * 1024 * 1024):
    manifest = {
        "schemaVersion":"1.0", "profileId":selected.profile_id, "profileFingerprint":"0"*64,
        "provider":selected.provider, "model":selected.model, "upstreamScheme":"https",
        "upstreamHost":"api.openai.com" if selected.provider == "codex" else "api.anthropic.com",
        "upstreamPort":443,
        "upstreamPaths":["/v1/responses" if selected.provider == "codex" else "/v1/messages"],
        "httpMethod":"POST", "maxRequestBytes":1024*1024,
        "maxResponseBytes":max_response_bytes, "timeoutSeconds":120,
        "sessionTtlSeconds":3600, "maxRequestsPerSession":128,
        "implementationDigest":selected.gateway_implementation_digest,
        "networkPolicyFingerprint":"7"*64, "credentialMode":"trusted-header-injection",
    }
    manifest["gatewayPolicyFingerprint"] = GatewayPolicy.fingerprint_manifest(manifest)
    selected = replace(selected, gateway_policy_digest=manifest["gatewayPolicyFingerprint"])
    manifest["profileFingerprint"] = selected.fingerprint
    return selected, GatewayPolicy.from_manifest(selected.fingerprint, manifest)


class SecondReworkFocusedTests(unittest.TestCase):
    def _service(self, root: Path, task, profiles, runner, *, profile_attestor=None, gateway_controller=None, transition_hook=None):
        source, base_sha = _source_repository(root)
        task["baseRef"] = base_sha
        policy = ContainmentPolicy(
            cpu_limit="1.0", memory_limit="128m", pids_limit=32,
            workspace_limit_bytes=16 * 1024 * 1024, wall_time_seconds=30,
            output_limit_bytes=65536, network_name="exec01-internal",
            allowed_endpoints=next(iter(profiles.values())).allowed_endpoints,
        )
        config = ExecutionRuntimeConfig(
            repository=task["repository"], source_repository_path=str(source),
            workspace_root=str(root / "workspaces"),
            execution_state_endpoint="https://graph.microsoft.com/v1.0/sites/site/lists/executions",
            execution_state_namespace="prod.exec01.executions",
            result_state_endpoint="https://graph.microsoft.com/v1.0/sites/site/lists/results",
            result_state_namespace="prod.exec01.results", profiles=profiles,
            containment_policy=policy,
            gateway_binding=GatewayNetworkBinding("exec01-internal", "exec01-gateway", "sha256:" + "a" * 64, policy.network_policy_fingerprint),
            github_repository="amengko-stack/sandiva", github_askpass_path="/opt/sandiva/bin/github-askpass",
        )
        hermes = Coordinator(InMemoryStateStore(), RuntimeConfig.from_mapping({
            "environmentKind":"development", "runtimeRole":"local-development", "environmentId":"q-test",
            "taskNamespace":"dev.exec01", "leaseDomain":"dev.exec01", "workerIdentity":"q-worker",
            "hermesVersion":"0.2.0", "stateBackend":"memory-test-only", "stateEndpoint":"memory://q", "resultMaxBytes":65536,
        }))
        service = ProductionExecutionService(
            config, hermes, InMemoryExecutionRecordStore(), ResultSink(), runner,
            TrustedGitHubPublisher(InMemoryGitHubGateway()),
            BoundArtifactResolver(
                pm_ref=task["originatingPmInstructionRef"], pm_instruction=__import__("helpers").PM_BYTES,
                specification_ref=task["specificationRef"], specification=SPEC_BYTES,
                acceptance_contract_ref=task["acceptanceContractRef"], acceptance_contract=AC_BYTES,
            ),
            profile_attestor, gateway_controller, transition_hook=transition_hook,
        )
        return service, hermes

    def test_q1_complete_approved_task_content_reaches_executor_and_binds_identity(self):
        executor_profile = profile("codex")
        task = dispatch_task(originatingPmInstructionFingerprint=hashlib.sha256(PM_BYTES).hexdigest())
        task["dispatchPolicy"]["executorProfile"] = {
            "profileId": executor_profile.profile_id,
            "profileFingerprint": executor_profile.fingerprint,
        }
        validated = validate_dispatch_build_task(task)
        lease = SimpleNamespace(attempt_id="attempt-q1", lease_id="lease-q1", fencing_token=1)
        request = normalize_execution_request(
            validated, fingerprint(validated), executor_profile, lease, resolved()
        )
        content = request.as_dict()["executionContent"]
        self.assertEqual(content["pmInstruction"], PM_BYTES.decode())
        self.assertEqual(content["scope"], task["scope"])
        self.assertEqual(content["acceptanceCriteria"], task["acceptanceCriteria"])
        self.assertEqual(content["evaluationRequirements"], task["evaluationRequirements"])
        self.assertEqual(content["qaRequirements"], task["qaRequirements"])
        self.assertEqual(content["specification"], SPEC_BYTES.decode())
        self.assertEqual(content["acceptanceContract"], AC_BYTES.decode())
        self.assertEqual(content["repository"], task["repository"])
        self.assertEqual(content["immutableBaseSha"], task["baseRef"])
        self.assertEqual(content["permittedRepositoryAreas"], task["permittedRepositoryAreas"])
        self.assertEqual(content["prohibitedRepositoryAreas"], task["prohibitedRepositoryAreas"])
        self.assertEqual(content["approvedCommands"], task["executorPolicy"]["approvedCommands"])

        baseline = request.execution_content_fingerprint
        for field in ("scope", "acceptanceCriteria", "evaluationRequirements", "qaRequirements"):
            candidate = copy.deepcopy(task)
            candidate[field] = [*candidate[field], f"changed-{field}"]
            if field == "acceptanceCriteria":
                candidate["criterionEvidencePolicy"]["changed-acceptanceCriteria"] = {
                    "allowedEvidence": [{"origin": "TRUSTED_COORDINATOR", "kind": "partner-gate"}]
                }
            candidate_request = normalize_execution_request(
                validate_dispatch_build_task(candidate),
                fingerprint(validate_dispatch_build_task(candidate)),
                executor_profile,
                lease,
                resolved(),
            )
            self.assertNotEqual(candidate_request.execution_content_fingerprint, baseline, field)
            self.assertNotEqual(candidate_request.task_fingerprint, request.task_fingerprint, field)

        changed_pm = ResolvedExecutionArtifacts(
            pm_instruction=b"Different PM instruction\n",
            specification=SPEC_BYTES,
            acceptance_contract=AC_BYTES,
        )
        with self.assertRaisesRegex(ExecutionContractError, "PM instruction fingerprint"):
            normalize_execution_request(validated, fingerprint(validated), executor_profile, lease, changed_pm)

        changed_pm_task = copy.deepcopy(task)
        changed_pm_task["originatingPmInstructionFingerprint"] = hashlib.sha256(changed_pm.pm_instruction).hexdigest()
        changed_pm_task = validate_dispatch_build_task(changed_pm_task)
        changed_pm_request = normalize_execution_request(
            changed_pm_task, fingerprint(changed_pm_task), executor_profile, lease, changed_pm,
        )
        self.assertNotEqual(changed_pm_request.task_fingerprint, request.task_fingerprint)
        self.assertNotEqual(changed_pm_request.execution_content_fingerprint, baseline)

        changed_spec = ResolvedExecutionArtifacts(
            pm_instruction=PM_BYTES, specification=b"Changed approved specification\n",
            acceptance_contract=AC_BYTES,
        )
        changed_spec_task = copy.deepcopy(task)
        changed_spec_task["specificationHash"] = hashlib.sha256(changed_spec.specification).hexdigest()
        changed_spec_task = validate_dispatch_build_task(changed_spec_task)
        changed_spec_request = normalize_execution_request(
            changed_spec_task, fingerprint(changed_spec_task), executor_profile, lease, changed_spec,
        )
        self.assertNotEqual(changed_spec_request.task_fingerprint, request.task_fingerprint)
        self.assertNotEqual(changed_spec_request.execution_content_fingerprint, baseline)

    def test_q6_raw_provider_api_objects_cannot_masquerade_as_completed_execution(self):
        executor_profile = profile("codex")
        request = request_for(executor_profile)
        raw_responses_api = {"id": "resp_1", "status": "completed", "output": []}
        with self.assertRaisesRegex(ExecutionContractError, "protocol"):
            CodexExecutionAdapter(
                executor_profile, SyntheticRunner("codex", raw_responses_api)
            ).execute(request, "/workspace")

    def test_q10_hermes_fail_cannot_qualify_even_when_package_is_signed(self):
        from test_exec01_vm_qualification import Exec01QualificationTests
        fixture = Exec01QualificationTests()
        fixture.setUp()
        evidence = fixture._evidence()
        evidence.pop("attestation")
        evidence["hermesEvidence"]["disposition"] = "FAIL"
        with self.assertRaises(SystemExit):
            signed = sign_evidence(evidence, fixture.key)
            verify_evidence(
                fixture.profiles, signed, attestation_key=fixture.key,
                trusted_resolver=fixture._resolver(signed),
            )

    def test_q14_closed_draft_pr_is_rejected(self):
        request = request_for(profile("codex"))
        gateway = InMemoryGitHubGateway()
        publisher = TrustedGitHubPublisher(gateway)
        publisher.publish_draft(request, changes(), "/workspace", lambda: None)
        gateway.prs[next(iter(gateway.prs))]["state"] = "closed"
        with self.assertRaisesRegex(PublicationConflict, "open"):
            publisher.publish_draft(request, changes(), "/workspace", lambda: None)

    def test_q15_provider_response_read_is_bounded_for_success_and_error(self):
        class Flood:
            status = 200
            headers = {"Content-Type": "application/json"}

            def __init__(self):
                self.requested = []

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, size=-1):
                self.requested.append(size)
                return b"x" * size

            def geturl(self):
                return self.url

        transport = UrlLibProviderHTTPTransport(response_limit_bytes=64)
        flood = Flood()
        from unittest.mock import patch

        with patch("hermes_steward.execution_gateway.urlopen", return_value=flood):
            with self.assertRaisesRegex(Exception, "size bound"):
                transport.request("https://provider.invalid", {}, {}, 1)
        self.assertEqual(flood.requested, [65])

        error = HTTPError("https://provider.invalid", 500, "bad", {}, io.BytesIO(b"x" * 1000))
        with patch("hermes_steward.execution_gateway.urlopen", side_effect=error):
            with self.assertRaisesRegex(Exception, "size bound"):
                transport.request("https://provider.invalid", {}, {}, 1)

        for provider, upstream in (("codex", "https://api.openai.com/v1/responses"),
                                   ("claude-code", "https://api.anthropic.com/v1/messages")):
            selected = profile(provider)
            selected, policy = gateway_policy_for(selected, max_response_bytes=64)
            provider_flood = Flood()
            provider_flood.url = policy.upstream_url
            proxy = BoundProviderProxy(policy, lambda: "trusted-provider-secret", opener=lambda *args, **kwargs: provider_flood)
            with self.subTest(provider=provider, response="success"), self.assertRaisesRegex(Exception, "gateway bound"):
                proxy.forward({"model": selected.model})
            self.assertEqual(provider_flood.requested, [65])
            provider_error = HTTPError(upstream, 500, "bad", {}, io.BytesIO(b"x" * 1000))
            proxy = BoundProviderProxy(policy, lambda: "trusted-provider-secret", opener=lambda *args, **kwargs: (_ for _ in ()).throw(provider_error))
            with self.subTest(provider=provider, response="error"), self.assertRaisesRegex(Exception, "gateway bound"):
                proxy.forward({"model": selected.model})

    def test_q3_production_service_reaches_source_controlled_gateway_control_plane(self):
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]; root.mkdir(parents=True)
        try:
            selected, gateway_policy = gateway_policy_for(profile("codex"))
            task = dispatch_task(taskId="Q03")
            task["dispatchPolicy"].update(executorProfile={"profileId": selected.profile_id, "profileFingerprint": selected.fingerprint}, permittedFallbackProfiles=[], fallbackMode="NONE")
            class Proxy:
                def forward(self, body): return 200, b'{"ok":true}', {"Content-Type":"application/json"}
            application = GatewayApplication(
                gateway_policy, GatewaySessionCodec(b"q3-gateway-session-signing-key-material"), Proxy(),
            )
            class Runner:
                token = None
                def bind_gateway_session(self, request, token): self.request, self.token = request, token
                def invoke(self, observed_profile, request, workspace):
                    application.authorize(self.token)
                    (Path(workspace) / "hermes-build-steward" / "README.md").write_text("q3\n")
                    return {"protocol":"codex-exec-jsonl-v1", "status":"completed", "started_at":"2026-09-07T00:00:00Z", "completed_at":"2026-09-07T00:00:01Z", "commands":[], "tests":[], "log_refs":[]}
            runner = Runner()
            service, _ = self._service(root, task, {"codex":selected}, runner, gateway_controller=GatewayControlPlane(application))
            record = service.dispatch(task)
            self.assertEqual(record.stage, ExecutionStage.RESULT_PERSISTED)
            self.assertIsNotNone(runner.token)
            claims = application.codec.verify(runner.token, gateway_policy)
            self.assertEqual((claims["taskFingerprint"], claims["attemptId"]), (runner.request.task_fingerprint, runner.request.attempt_id))
            application.execute(runner.token, {"model": selected.model, "input":"bounded"})
            with self.assertRaisesRegex(Exception, "replay"):
                application.execute(runner.token, {"model": selected.model, "input":"bounded"})
        finally: shutil.rmtree(root, ignore_errors=True)

    def test_q7_observed_profile_mismatch_fails_dispatch_before_executor(self):
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]; root.mkdir(parents=True)
        try:
            selected = profile("codex")
            task = dispatch_task(); task["dispatchPolicy"].update(executorProfile={"profileId":selected.profile_id,"profileFingerprint":selected.fingerprint}, permittedFallbackProfiles=[], fallbackMode="NONE")
            class Runner:
                calls = 0
                def invoke(self, *args): self.calls += 1; raise AssertionError("must not execute")
            class Attestor:
                def attest(self, observed_profile):
                    return replace(ObservedExecutorIdentity.from_profile(observed_profile), executable_digest="0" * 64)
            runner = Runner(); service, _ = self._service(root, task, {"codex":selected}, runner, profile_attestor=Attestor())
            with self.assertRaisesRegex(ExecutionContractError, "observed executor identity"):
                service.dispatch(task)
            self.assertEqual(runner.calls, 0)
        finally: shutil.rmtree(root, ignore_errors=True)

    def test_q8_authorized_primary_outage_creates_explicit_fallback_attempt(self):
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]; root.mkdir(parents=True)
        try:
            codex, claude = profile("codex"), profile("claude-code")
            claude = replace(claude, allowed_endpoints=codex.allowed_endpoints)
            task = dispatch_task(taskId="Q08", retryPolicy={"maxAttempts":3,"backoffSeconds":0})
            task["dispatchPolicy"].update(
                executorProfile={"profileId":codex.profile_id,"profileFingerprint":codex.fingerprint},
                permittedFallbackProfiles=[{"profileId":claude.profile_id,"profileFingerprint":claude.fingerprint}], fallbackMode="ORDERED",
            )
            class Runner:
                calls = []
                def invoke(self, selected, request, workspace):
                    self.calls.append((selected.profile_id, request.attempt_id, request.as_dict()["fallbackContext"]))
                    if selected.provider == "codex": return {"protocol":"codex-exec-jsonl-v1", "status":"failed", "started_at":"2026-09-07T00:00:00Z", "completed_at":"2026-09-07T00:00:01Z", "commands":[], "tests":[], "log_refs":[], "error_type":"provider_unavailable"}
                    (Path(workspace) / "hermes-build-steward" / "README.md").write_text("fallback\n")
                    return {"protocol":"claude-code-stream-json-v1", "stop_reason":"end_turn", "startedAt":"2026-09-07T00:00:02Z", "completedAt":"2026-09-07T00:00:03Z", "commandsExecuted":[], "testOutcomes":[], "evidenceReferences":[]}
            runner = Runner(); service, hermes = self._service(root, task, {"codex":codex,"claude-code":claude}, runner)
            record = service.dispatch(task)
            self.assertEqual(record.stage, ExecutionStage.RESULT_PERSISTED)
            self.assertEqual(len({attempt for _, attempt, _ in runner.calls}), 2)
            self.assertEqual(runner.calls[1][2]["failureClassification"], "PROVIDER_UNAVAILABLE")
            durable = hermes.store.get(f"dev.exec01:{task['taskId']}:{task['taskVersion']}").value
            self.assertEqual(durable.failure_history[0]["disposition"], "PROVIDER_UNAVAILABLE")
        finally: shutil.rmtree(root, ignore_errors=True)

    def test_q9_unauthorized_silent_fallback_is_denied(self):
        root = Path.cwd() / ".t" / uuid.uuid4().hex[:8]; root.mkdir(parents=True)
        try:
            codex = profile("codex")
            task = dispatch_task(taskId="Q09"); task["dispatchPolicy"].update(executorProfile={"profileId":codex.profile_id,"profileFingerprint":codex.fingerprint}, permittedFallbackProfiles=[], fallbackMode="NONE")
            class Runner:
                calls = 0
                def invoke(self, selected, request, workspace):
                    self.calls += 1
                    return {"protocol":"codex-exec-jsonl-v1", "status":"failed", "started_at":"2026-09-07T00:00:00Z", "completed_at":"2026-09-07T00:00:01Z", "commands":[], "tests":[], "log_refs":[], "error_type":"provider_unavailable"}
            runner = Runner(); service, _ = self._service(root, task, {"codex":codex}, runner)
            record = service.dispatch(task)
            self.assertEqual(record.failure_classification, "PROVIDER_UNAVAILABLE")
            self.assertEqual(runner.calls, 1)
        finally: shutil.rmtree(root, ignore_errors=True)

    def test_q11_signed_but_fabricated_evidence_cannot_qualify(self):
        from test_exec01_vm_qualification import Exec01QualificationTests
        fixture = Exec01QualificationTests(); fixture.setUp(); actual = fixture._evidence()
        fabricated = copy.deepcopy(actual); fabricated.pop("attestation"); fabricated["pullRequestReadback"][0]["number"] = 999; fabricated = sign_evidence(fabricated, fixture.key)
        with self.assertRaisesRegex(SystemExit, "independently acquired"):
            verify_evidence(fixture.profiles, fabricated, attestation_key=fixture.key, trusted_resolver=fixture._resolver(actual))

    def test_q12_collector_resolves_task_records_github_and_hermes_before_signing(self):
        from test_exec01_third_rework import authoritative_collector_fixture
        collector, profiles = authoritative_collector_fixture()
        key=b"q12-trusted-collector-signing-key-material"
        signed=collector.collect_and_sign(profiles,key)
        self.assertEqual(verify_evidence(profiles,signed,attestation_key=key,trusted_resolver=collector)["status"],"CODE_QA_EVIDENCE_VERIFIED")

    def test_q13_prior_attempt_publication_conflicts_under_strict_attempt_ownership(self):
        first = request_for(profile("codex")); second = replace(first, attempt_id="attempt-recovery-2", lease_id="lease-recovery-2", fencing_token=8)
        gateway=InMemoryGitHubGateway(); publisher=TrustedGitHubPublisher(gateway)
        publisher.publish_draft(first,changes(),"/workspace",lambda:None)
        with self.assertRaisesRegex(PublicationConflict,"ownership"):
            publisher.publish_draft(second,changes(),"/workspace",lambda:None)


if __name__ == "__main__":
    unittest.main()
