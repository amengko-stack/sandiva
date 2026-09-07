from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import urlparse

from .contracts import fingerprint, validate_dispatch_build_task, validate_reference_hashes
from .coordinator import Coordinator, Lease, StaleFenceError
from .execution_adapters import ClaudeCodeExecutionAdapter, CodexExecutionAdapter
from .execution_contracts import (
    ExecutorProfile,
    ExecutorProfileRegistry,
    ResolvedExecutionArtifacts,
    ObservedExecutorIdentity,
    normalize_execution_request,
)
from .execution_coordinator import (
    CasExecutionRecordStore,
    ExecutionCoordinator,
    ExecutionRecord,
    ExecutionStage,
    RecoveryError,
    build_execution_audit_record,
    execution_record_from_dict,
    execution_record_to_dict,
    select_executor_profile,
)
from .execution_isolation import (
    ContainerProviderRunner,
    ContainmentPolicy,
    DockerContainerJobRunner,
    DockerNetworkAttestor,
    GatewayNetworkBinding,
    WorkspaceFactory,
)
from .execution_publisher import GitHubPublisherGateway, TrustedGitHubPublisher
from .prepublication import PrepublicationInspector
from .sharepoint_store import SharePointListStateStore
from .store import RecordNotFound, StateStore, StoreConflict


class ExecutionRuntimeConfigurationError(ValueError):
    pass


class TrustedArtifactResolver(Protocol):
    def resolve(self, task: Mapping[str, Any]) -> ResolvedExecutionArtifacts: ...


class ExecutorProfileAttestor(Protocol):
    def attest(self, profile: ExecutorProfile) -> ObservedExecutorIdentity: ...


class ExecutorGatewayController(Protocol):
    def prepare(self, profile: ExecutorProfile, request: Any) -> str: ...


class DockerExecutorGatewayController:
    """Trusted host control path into the reviewed, pinned gateway container."""

    def __init__(self, binding: GatewayNetworkBinding):
        self.binding = binding

    def _run(self, args: list[str]) -> str:
        try:
            return subprocess.check_output(
                ["docker", "exec", self.binding.container_name, "/opt/sandiva/bin/exec01-gateway", *args],
                text=True, stderr=subprocess.PIPE, timeout=30,
                env={"PATH": os.defpath, "LANG": "C.UTF-8"},
            ).strip()
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            raise ExecutionRuntimeConfigurationError("trusted executor gateway control path failed") from error

    def prepare(self, profile: ExecutorProfile, request: Any) -> str:
        try:
            health = json.loads(self._run(["health"]))
        except json.JSONDecodeError as error:
            raise ExecutionRuntimeConfigurationError("trusted executor gateway health is malformed") from error
        expected = {"policyFingerprint": profile.gateway_policy_digest, "implementationDigest": profile.gateway_implementation_digest}
        if health.get("status") != "READY" or health.get("profiles", {}).get(profile.fingerprint) != expected:
            raise ExecutionRuntimeConfigurationError("trusted executor gateway identity/policy mismatch")
        token = self._run([
            "issue", "--task-fingerprint", request.task_fingerprint,
            "--attempt-id", request.attempt_id,
            "--profile-fingerprint", profile.fingerprint,
        ])
        if len(token) < 64:
            raise ExecutionRuntimeConfigurationError("trusted executor gateway returned an invalid session")
        return token


class DockerExecutorProfileAttestor:
    """Observe the pinned image's wrapper and executable before dispatch."""

    def attest(self, profile: ExecutorProfile) -> ObservedExecutorIdentity:
        try:
            raw = subprocess.check_output(
                [
                    "docker", "run", "--rm", "--network", "none", "--read-only",
                    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                    "--entrypoint", "/opt/sandiva/bin/exec01-runtime", profile.image,
                    "attest", profile.fixed_argv[0], profile.model,
                    profile.gateway_implementation_digest, profile.gateway_policy_digest,
                ],
                stderr=subprocess.PIPE,
                env={"PATH": os.defpath, "LANG": "C.UTF-8"},
                timeout=30,
            )
            value = json.loads(raw)
            observed = ObservedExecutorIdentity(image=profile.image, **{
                "runtime_wrapper_digest": value["runtimeWrapperDigest"],
                "executable_digest": value["executableDigest"],
                "executable_version": value["executableVersion"],
                "launcher_version": value["launcherVersion"],
                "model": value["model"],
                "gateway_implementation_digest": value["gatewayImplementationDigest"],
                "gateway_policy_digest": value["gatewayPolicyDigest"],
            })
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError, KeyError, TypeError) as error:
            raise ExecutionRuntimeConfigurationError("executor profile attestation failed") from error
        observed.assert_matches(profile)
        return observed


class BoundArtifactResolver:
    """Operator/trusted-store supplied artifacts bound to the exact task references."""

    def __init__(
        self,
        *,
        pm_ref: str,
        pm_instruction: bytes,
        specification_ref: str,
        specification: bytes,
        acceptance_contract_ref: str,
        acceptance_contract: bytes,
    ):
        self._refs = (pm_ref, specification_ref, acceptance_contract_ref)
        self._artifacts = ResolvedExecutionArtifacts(pm_instruction, specification, acceptance_contract)

    def resolve(self, task: Mapping[str, Any]) -> ResolvedExecutionArtifacts:
        observed = (
            task.get("originatingPmInstructionRef"),
            task.get("specificationRef"),
            task.get("acceptanceContractRef"),
        )
        if observed != self._refs:
            raise ExecutionRuntimeConfigurationError("task artifact references do not match trusted resolver binding")
        # Hash verification occurs again while constructing the normalized request.
        self._artifacts.verified_content(task)
        return self._artifacts


def _verify_source_repository(path: Path, expected_repository: str) -> None:
    environment = {
        "PATH": os.defpath,
        "LANG": "C.UTF-8",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_PROTOCOL_FROM_USER": "0",
    }
    try:
        observed = subprocess.check_output(
            ["git", "-C", str(path), "remote", "get-url", "origin"],
            text=True, stderr=subprocess.PIPE, env=environment,
        ).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise ExecutionRuntimeConfigurationError("trusted source repository identity is unavailable") from error
    accepted = {expected_repository, expected_repository + ".git"}
    if observed not in accepted:
        raise ExecutionRuntimeConfigurationError("trusted source repository origin is not the approved repository")


def _linux_path(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ExecutionRuntimeConfigurationError(f"{field} must be an absolute Linux path")
    path = PurePosixPath(value)
    lowered = value.lower()
    if not path.is_absolute() or ".." in path.parts or "\\" in value or "onedrive" in lowered or "c:\\users" in lowered:
        raise ExecutionRuntimeConfigurationError(f"{field} must be an absolute external Linux path")
    return value


def _graph_list_endpoint(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ExecutionRuntimeConfigurationError(f"{field} must be a Graph list endpoint")
    parsed = urlparse(value)
    parts = parsed.path.strip("/").split("/")
    if (
        parsed.scheme != "https" or parsed.netloc.lower() != "graph.microsoft.com"
        or len(parts) != 5 or parts[0] != "v1.0" or parts[1] != "sites" or parts[3] != "lists"
        or any(not part or "{" in part or "}" in part for part in parts)
        or parsed.query or parsed.fragment
    ):
        raise ExecutionRuntimeConfigurationError(f"{field} must identify one exact Microsoft Graph list")
    return value.rstrip("/")


@dataclass(frozen=True)
class ExecutionRuntimeConfig:
    repository: str
    source_repository_path: str
    workspace_root: str
    execution_state_endpoint: str
    execution_state_namespace: str
    result_state_endpoint: str
    result_state_namespace: str
    profiles: Mapping[str, ExecutorProfile]
    containment_policy: ContainmentPolicy
    gateway_binding: GatewayNetworkBinding
    github_repository: str
    github_askpass_path: str

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> "ExecutionRuntimeConfig":
        expected = {
            "repository", "sourceRepositoryPath", "workspaceRoot", "executionStateEndpoint",
            "executionStateNamespace", "resultStateEndpoint", "resultStateNamespace", "executorProfiles",
            "containmentPolicy", "gatewayBinding", "githubPublisher",
        }
        if not isinstance(raw, Mapping) or set(raw) != expected:
            raise ExecutionRuntimeConfigurationError("EXEC-01 runtime configuration fields are invalid")
        if raw["repository"] != "https://github.com/amengko-stack/sandiva":
            raise ExecutionRuntimeConfigurationError("EXEC-01 repository is not the approved Sandiva repository")
        profiles_raw = raw["executorProfiles"]
        if not isinstance(profiles_raw, Mapping) or set(profiles_raw) != {"codex", "claude-code"}:
            raise ExecutionRuntimeConfigurationError("exact Codex and Claude Code profiles are required")
        try:
            profiles = {provider: ExecutorProfile(**dict(value)) for provider, value in profiles_raw.items()}
        except (TypeError, ValueError) as error:
            raise ExecutionRuntimeConfigurationError("executor profile configuration is invalid") from error
        if any(profile.provider != provider for provider, profile in profiles.items()):
            raise ExecutionRuntimeConfigurationError("executor profile provider binding is invalid")
        policy_raw = raw["containmentPolicy"]
        if not isinstance(policy_raw, Mapping) or set(policy_raw) != {
            "cpuLimit", "memoryLimit", "pidsLimit", "workspaceLimitBytes", "wallTimeSeconds",
            "outputLimitBytes", "networkName", "allowedEndpoints",
        }:
            raise ExecutionRuntimeConfigurationError("containment policy fields are invalid")
        try:
            policy = ContainmentPolicy(
                cpu_limit=policy_raw["cpuLimit"], memory_limit=policy_raw["memoryLimit"],
                pids_limit=policy_raw["pidsLimit"], workspace_limit_bytes=policy_raw["workspaceLimitBytes"],
                wall_time_seconds=policy_raw["wallTimeSeconds"], output_limit_bytes=policy_raw["outputLimitBytes"],
                network_name=policy_raw["networkName"], allowed_endpoints=tuple(policy_raw["allowedEndpoints"]),
            )
        except (TypeError, ValueError) as error:
            raise ExecutionRuntimeConfigurationError("containment policy is invalid") from error
        if any(set(profile.allowed_endpoints) != set(policy.allowed_endpoints) for profile in profiles.values()):
            raise ExecutionRuntimeConfigurationError("profiles and containment endpoint policy must match")
        gateway_raw = raw["gatewayBinding"]
        if not isinstance(gateway_raw, Mapping) or set(gateway_raw) != {
            "networkName", "containerName", "image", "policyFingerprint",
        }:
            raise ExecutionRuntimeConfigurationError("gateway binding fields are invalid")
        try:
            gateway = GatewayNetworkBinding(
                network_name=gateway_raw["networkName"], container_name=gateway_raw["containerName"],
                image=gateway_raw["image"], policy_fingerprint=gateway_raw["policyFingerprint"],
            )
        except (TypeError, ValueError) as error:
            raise ExecutionRuntimeConfigurationError("gateway binding is invalid") from error
        if gateway.network_name != policy.network_name or gateway.policy_fingerprint != policy.network_policy_fingerprint:
            raise ExecutionRuntimeConfigurationError("gateway binding and containment network mismatch")
        gateway_image_digest = gateway.image.rsplit("sha256:", 1)[-1]
        if any(profile.gateway_policy_digest != gateway.policy_fingerprint for profile in profiles.values()):
            raise ExecutionRuntimeConfigurationError("executor profile gateway policy digest mismatch")
        if any(profile.gateway_implementation_digest != gateway_image_digest for profile in profiles.values()):
            raise ExecutionRuntimeConfigurationError("executor profile gateway implementation digest mismatch")
        publisher = raw["githubPublisher"]
        if not isinstance(publisher, Mapping) or set(publisher) != {"repository", "askpassPath"}:
            raise ExecutionRuntimeConfigurationError("GitHub publisher fields are invalid")
        if publisher["repository"] != "amengko-stack/sandiva":
            raise ExecutionRuntimeConfigurationError("GitHub publisher repository is not approved")
        for namespace_field in ("executionStateNamespace", "resultStateNamespace"):
            value = raw[namespace_field]
            if not isinstance(value, str) or not value.startswith("prod.exec01."):
                raise ExecutionRuntimeConfigurationError(f"{namespace_field} must be a dedicated production namespace")
        if raw["executionStateNamespace"] == raw["resultStateNamespace"]:
            raise ExecutionRuntimeConfigurationError("execution and result namespaces must be separate")
        return cls(
            repository=raw["repository"], source_repository_path=_linux_path(raw["sourceRepositoryPath"], "sourceRepositoryPath"),
            workspace_root=_linux_path(raw["workspaceRoot"], "workspaceRoot"),
            execution_state_endpoint=_graph_list_endpoint(raw["executionStateEndpoint"], "executionStateEndpoint"),
            execution_state_namespace=raw["executionStateNamespace"],
            result_state_endpoint=_graph_list_endpoint(raw["resultStateEndpoint"], "resultStateEndpoint"),
            result_state_namespace=raw["resultStateNamespace"], profiles=profiles,
            containment_policy=policy, gateway_binding=gateway,
            github_repository=publisher["repository"],
            github_askpass_path=_linux_path(publisher["askpassPath"], "githubPublisher.askpassPath"),
        )


class CasResultSink:
    def __init__(self, store: StateStore[Mapping[str, Any]]):
        self.store = store

    def put(self, identity: str, value: Mapping[str, Any]) -> None:
        payload = json.loads(json.dumps(dict(value)))
        try:
            self.store.create(identity, payload)
        except StoreConflict:
            current = self.store.get(identity).value
            if current != payload:
                raise RecoveryError("conflicting durable result")


class HermesExecutionAuthority:
    def __init__(self, coordinator: Coordinator, request: Any):
        self.coordinator = coordinator
        self.request = request

    def assert_current(self) -> None:
        key = f"{self.coordinator.config.task_namespace}:{self.request.task_id}:{self.request.task_version}"
        try:
            record = self.coordinator.store.get(key).value
        except RecordNotFound as error:
            raise StaleFenceError("authoritative task state is missing") from error
        lease = record.active_lease
        if (
            record.task_fingerprint != self.request.task_fingerprint or lease is None
            or lease.attempt_id != self.request.attempt_id or lease.lease_id != self.request.lease_id
            or lease.fencing_token != self.request.fencing_token
            or lease.lease_expires_at <= self.coordinator.clock()
        ):
            raise StaleFenceError("execution attempt no longer owns current Hermes authority")


class ProductionExecutionService:
    def __init__(
        self,
        config: ExecutionRuntimeConfig,
        hermes: Coordinator,
        execution_store: CasExecutionRecordStore,
        result_sink: CasResultSink,
        runner: ContainerProviderRunner,
        publisher: TrustedGitHubPublisher,
        artifact_resolver: TrustedArtifactResolver,
        profile_attestor: ExecutorProfileAttestor | None = None,
        gateway_controller: ExecutorGatewayController | None = None,
    ):
        self.config = config
        self.hermes = hermes
        self.execution_store = execution_store
        self.result_sink = result_sink
        self.runner = runner
        self.publisher = publisher
        self.artifact_resolver = artifact_resolver
        self.profile_attestor = profile_attestor
        self.gateway_controller = gateway_controller
        self.registry = ExecutorProfileRegistry(config.profiles.values())
        self.workspace_factory = WorkspaceFactory(Path(config.workspace_root))
        self.inspector = PrepublicationInspector()
        self.source_repository = Path(config.source_repository_path)

    def _lease_for_dispatch(self, task: Mapping[str, Any], specification: bytes, acceptance_contract: bytes) -> Lease:
        record = self.hermes.submit_task(task, specification, acceptance_contract)
        if record.active_lease is not None and record.active_lease.lease_expires_at > self.hermes.clock():
            if record.active_lease.worker_id != self.hermes.config.worker_identity:
                raise StaleFenceError("task is leased by another worker")
            return record.active_lease
        lease_ttl = max(3600, self.config.containment_policy.wall_time_seconds + 300)
        return self.hermes.claim(
            task["taskId"], task["taskVersion"], self.hermes.config.worker_identity, lease_ttl
        )

    def _execute(
        self, task: Mapping[str, Any], lease: Lease, *, resume: bool,
        unavailable: frozenset[str] = frozenset(),
        fallback_context: Mapping[str, Any] | None = None,
    ) -> ExecutionRecord:
        if task["repository"] != self.config.repository:
            raise ExecutionRuntimeConfigurationError("task repository does not match trusted runtime configuration")
        selected = select_executor_profile(task, self.registry, unavailable)
        artifacts = self.artifact_resolver.resolve(task)
        observed = (
            self.profile_attestor.attest(selected)
            if self.profile_attestor is not None
            else ObservedExecutorIdentity.from_profile(selected)
        )
        request = normalize_execution_request(
            task, fingerprint(task), selected, lease, artifacts, observed,
            fallback_context,
        )
        if self.gateway_controller is not None:
            token = self.gateway_controller.prepare(selected, request)
            binder = getattr(self.runner, "bind_gateway_session", None)
            if not callable(binder):
                raise ExecutionRuntimeConfigurationError("provider runner cannot bind a trusted gateway session")
            binder(request, token)
        authority = HermesExecutionAuthority(self.hermes, request)
        adapter = (
            CodexExecutionAdapter(selected, self.runner)
            if selected.provider == "codex"
            else ClaudeCodeExecutionAdapter(selected, self.runner)
        )
        coordinator = ExecutionCoordinator(
            self.execution_store, self.workspace_factory, adapter, self.inspector,
            self.publisher, self.result_sink, authority.assert_current,
            source_repository=self.source_repository,
        )
        record = coordinator.resume(request) if resume else coordinator.dispatch(request)
        if record.stage == ExecutionStage.RESULT_PERSISTED:
            self.result_sink.put(f"audit:{record.identity}", build_execution_audit_record(request, record))
        return record

    def _run_with_authorized_fallback(
        self, task: Mapping[str, Any], lease: Lease, *, resume: bool,
    ) -> ExecutionRecord:
        unavailable: set[str] = set()
        context: Mapping[str, Any] | None = None
        current_lease = lease
        should_resume = resume
        while True:
            record = self._execute(
                task, current_lease, resume=should_resume,
                unavailable=frozenset(unavailable), fallback_context=context,
            )
            if record.failure_classification != "PROVIDER_UNAVAILABLE":
                return record
            result = record.execution_result or {}
            executor = result.get("executorProfile") if isinstance(result, Mapping) else None
            unavailable_profile = executor.get("profileId") if isinstance(executor, Mapping) else None
            if not isinstance(unavailable_profile, str):
                return record
            self.hermes.record_execution_unavailable(
                task["taskId"], task["taskVersion"], current_lease.lease_id,
                current_lease.fencing_token, unavailable_profile,
            )
            unavailable.add(unavailable_profile)
            references = [
                task["dispatchPolicy"]["executorProfile"],
                *task["dispatchPolicy"]["permittedFallbackProfiles"],
            ]
            remaining = [item for item in references if item["profileId"] not in unavailable]
            if task["dispatchPolicy"]["fallbackMode"] != "ORDERED" or not remaining:
                return record
            primary_attempt = current_lease.attempt_id
            lease_ttl = max(3600, self.config.containment_policy.wall_time_seconds + 300)
            current_lease = self.hermes.claim(
                task["taskId"], task["taskVersion"], self.hermes.config.worker_identity, lease_ttl,
            )
            context = {
                "primaryAttemptId": primary_attempt,
                "unavailableProfileId": unavailable_profile,
                "failureClassification": "PROVIDER_UNAVAILABLE",
            }
            should_resume = False

    def cancel(self, raw_task: Mapping[str, Any]) -> ExecutionRecord:
        task = validate_dispatch_build_task(raw_task)
        key = f"{self.hermes.config.task_namespace}:{task['taskId']}:{task['taskVersion']}"
        durable = self.hermes.store.get(key).value
        if durable.task_fingerprint != fingerprint(task) or durable.active_lease is None:
            raise StaleFenceError("task does not have the expected current execution lease")
        selected = select_executor_profile(task, self.registry, frozenset())
        request = normalize_execution_request(
            task, durable.task_fingerprint, selected, durable.active_lease,
            self.artifact_resolver.resolve(task),
            self.profile_attestor.attest(selected) if self.profile_attestor is not None else ObservedExecutorIdentity.from_profile(selected),
        )
        self.runner.cancel(request)
        authority = HermesExecutionAuthority(self.hermes, request)
        adapter = (
            CodexExecutionAdapter(selected, self.runner)
            if selected.provider == "codex"
            else ClaudeCodeExecutionAdapter(selected, self.runner)
        )
        coordinator = ExecutionCoordinator(
            self.execution_store, self.workspace_factory, adapter, self.inspector,
            self.publisher, self.result_sink, authority.assert_current,
            source_repository=self.source_repository,
        )
        return coordinator.cancel(request)

    def dispatch(self, raw_task: Mapping[str, Any]) -> ExecutionRecord:
        task = validate_dispatch_build_task(raw_task)
        artifacts = self.artifact_resolver.resolve(task)
        validate_reference_hashes(task, artifacts.specification, artifacts.acceptance_contract)
        lease = self._lease_for_dispatch(task, artifacts.specification, artifacts.acceptance_contract)
        return self._run_with_authorized_fallback(task, lease, resume=False)

    def resume(self, raw_task: Mapping[str, Any]) -> ExecutionRecord:
        task = validate_dispatch_build_task(raw_task)
        key = f"{self.hermes.config.task_namespace}:{task['taskId']}:{task['taskVersion']}"
        record = self.hermes.store.get(key).value
        if record.task_fingerprint != fingerprint(task) or record.active_lease is None:
            raise StaleFenceError("task does not have the expected current execution lease")
        return self._run_with_authorized_fallback(task, record.active_lease, resume=True)


def build_production_execution_service(
    hermes: Coordinator,
    config: ExecutionRuntimeConfig,
    graph_token_provider: Callable[[], str],
    github_credential_provider: Callable[[], str],
    artifact_resolver: TrustedArtifactResolver,
) -> ProductionExecutionService:
    for executor_profile in config.profiles.values():
        if (
            executor_profile.executable_digest == "0" * 64
            or executor_profile.runtime_wrapper_digest == "0" * 64
            or executor_profile.gateway_implementation_digest == "0" * 64
            or executor_profile.gateway_policy_digest == "0" * 64
            or executor_profile.image.endswith("sha256:" + "0" * 64)
            or executor_profile.image.startswith("registry.example/")
        ):
            raise ExecutionRuntimeConfigurationError("placeholder executor profile is not deployable")
    if (
        config.gateway_binding.policy_fingerprint == "0" * 64
        or config.gateway_binding.image.endswith("sha256:" + "0" * 64)
        or config.gateway_binding.image.startswith("registry.example/")
    ):
        raise ExecutionRuntimeConfigurationError("placeholder gateway binding is not deployable")
    source = Path(config.source_repository_path)
    askpass = Path(config.github_askpass_path)
    if not source.is_dir():
        raise ExecutionRuntimeConfigurationError("trusted source repository is unavailable")
    _verify_source_repository(source, config.repository)
    if not askpass.is_file():
        raise ExecutionRuntimeConfigurationError("trusted GitHub askpass helper is unavailable")
    if not github_credential_provider():
        raise ExecutionRuntimeConfigurationError("trusted GitHub publisher credential is unavailable")
    execution_state = SharePointListStateStore(
        config.execution_state_endpoint, config.execution_state_namespace,
        hermes.config.environment_id, graph_token_provider,
        record_encoder=execution_record_to_dict, record_decoder=execution_record_from_dict,
        status_getter=lambda value: value.stage.value,
    )
    result_state = SharePointListStateStore(
        config.result_state_endpoint, config.result_state_namespace,
        hermes.config.environment_id, graph_token_provider,
        record_encoder=lambda value: dict(value), record_decoder=lambda value: dict(value),
        status_getter=lambda value: str(value.get("disposition", value.get("schemaVersion", "AUDIT"))),
    )
    attestor = DockerNetworkAttestor(config.gateway_binding)
    for executor_profile in config.profiles.values():
        attestor.attest(executor_profile, config.containment_policy)
    job_runner = DockerContainerJobRunner(config.containment_policy, network_attestor=attestor)
    provider_runner = ContainerProviderRunner(config.containment_policy, Path(config.workspace_root) / ".requests", runner=job_runner)
    gateway = GitHubPublisherGateway(
        config.github_repository, credential_provider=github_credential_provider,
        askpass_path=config.github_askpass_path,
    )
    return ProductionExecutionService(
        config, hermes, CasExecutionRecordStore(execution_state), CasResultSink(result_state),
        provider_runner, TrustedGitHubPublisher(gateway), artifact_resolver,
        DockerExecutorProfileAttestor(), DockerExecutorGatewayController(config.gateway_binding),
    )
