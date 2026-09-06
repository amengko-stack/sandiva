from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Mapping
from urllib.parse import urlparse

from .contracts import fingerprint


class ConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class GraphAuthenticationConfig:
    provider: str
    tenant_id: str | None = None
    client_id: str | None = None
    certificate_path: str | None = None

    @classmethod
    def from_mapping(cls, raw: Any) -> "GraphAuthenticationConfig":
        if not isinstance(raw, Mapping):
            raise ConfigurationError("graphAuthentication must be an object")
        provider = raw.get("provider")
        if provider == "entra-certificate":
            required = {"provider", "tenantId", "clientId", "certificatePath"}
            if set(raw) != required:
                raise ConfigurationError("entra-certificate authentication fields are invalid")
            for field in required - {"provider"}:
                if not isinstance(raw[field], str) or not raw[field].strip():
                    raise ConfigurationError(f"graphAuthentication.{field} must be a non-empty string")
            certificate_path = raw["certificatePath"]
            certificate_parts = PurePosixPath(certificate_path).parts
            normalized_certificate_path = certificate_path.replace("//", "/").rstrip("/").lower()
            if (
                not PurePosixPath(certificate_path).is_absolute()
                or ".." in certificate_parts
                or "\\" in certificate_path
                or "c:\\users" in certificate_path.lower()
                or "onedrive" in certificate_path.lower()
                or normalized_certificate_path.startswith((
                    "/tmp/", "/var/tmp/", "/opt/sandiva/hermes-build-steward/",
                ))
            ):
                raise ConfigurationError("certificatePath must be an absolute external Linux credential path")
            return cls(
                provider=provider,
                tenant_id=raw["tenantId"],
                client_id=raw["clientId"],
                certificate_path=certificate_path,
            )
        if provider == "azure-managed-identity":
            if set(raw) not in ({"provider"}, {"provider", "clientId"}):
                raise ConfigurationError("azure-managed-identity authentication fields are invalid")
            client_id = raw.get("clientId")
            if client_id is not None and (not isinstance(client_id, str) or not client_id.strip()):
                raise ConfigurationError("graphAuthentication.clientId must be a non-empty string when supplied")
            return cls(provider=provider, client_id=client_id)
        raise ConfigurationError("unsupported graph authentication provider")

    def as_mapping(self) -> dict[str, str]:
        value = {"provider": self.provider}
        if self.tenant_id is not None:
            value["tenantId"] = self.tenant_id
        if self.client_id is not None:
            value["clientId"] = self.client_id
        if self.certificate_path is not None:
            value["certificatePath"] = self.certificate_path
        return value


@dataclass(frozen=True)
class RuntimeConfig:
    environment_kind: str
    runtime_role: str
    environment_id: str
    task_namespace: str
    lease_domain: str
    worker_identity: str
    hermes_version: str
    state_backend: str
    state_endpoint: str
    result_max_bytes: int
    vm_provider: str | None = None
    graph_authentication: GraphAuthenticationConfig | None = None

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> "RuntimeConfig":
        base_required = {
            "environmentKind", "runtimeRole", "environmentId", "taskNamespace", "leaseDomain",
            "workerIdentity", "hermesVersion", "stateBackend", "stateEndpoint", "resultMaxBytes",
        }
        required = set(base_required)
        if raw.get("environmentKind") == "production":
            required.update({"vmProvider", "graphAuthentication"})
        if set(raw) != required:
            raise ConfigurationError("runtime configuration fields must exactly match the Phase 1 schema")
        for field in base_required - {"resultMaxBytes"}:
            if not isinstance(raw[field], str) or not raw[field].strip():
                raise ConfigurationError(f"{field} must be a non-empty string")
        if not isinstance(raw["resultMaxBytes"], int) or isinstance(raw["resultMaxBytes"], bool) or raw["resultMaxBytes"] < 1024:
            raise ConfigurationError("resultMaxBytes must be an integer of at least 1024")

        kind = raw["environmentKind"]
        role = raw["runtimeRole"]
        namespace = raw["taskNamespace"].lower()
        lease_domain = raw["leaseDomain"].lower()
        endpoint = raw["stateEndpoint"]
        vm_provider = None
        graph_authentication = None
        if kind not in {"development", "test", "production"}:
            raise ConfigurationError("environmentKind is invalid")
        if kind != "production" and (namespace.startswith("prod") or lease_domain.startswith("prod")):
            raise ConfigurationError("non-production runtime cannot address a production task namespace or lease domain")
        if kind == "production":
            vm_provider = raw["vmProvider"]
            if vm_provider not in {"hostinger", "azure"}:
                raise ConfigurationError("vmProvider is invalid")
            graph_authentication = GraphAuthenticationConfig.from_mapping(raw["graphAuthentication"])
            if vm_provider == "hostinger" and graph_authentication.provider != "entra-certificate":
                raise ConfigurationError("Hostinger production requires entra-certificate Graph authentication")
            if role != "authoritative-vm":
                raise ConfigurationError("production requires the authoritative-vm runtime role")
            if raw["stateBackend"] != "sharepoint-list":
                raise ConfigurationError("production requires externally durable SharePoint List state")
            parsed = urlparse(endpoint)
            if parsed.scheme != "https" or parsed.netloc.lower() != "graph.microsoft.com":
                raise ConfigurationError("production stateEndpoint must be an HTTPS Microsoft Graph endpoint")
            path_parts = parsed.path.strip("/").split("/")
            if (
                len(path_parts) != 5
                or path_parts[0] != "v1.0"
                or path_parts[1] != "sites"
                or path_parts[3] != "lists"
                or any(not part or "{" in part or "}" in part for part in path_parts)
                or parsed.params
                or parsed.query
                or parsed.fragment
            ):
                raise ConfigurationError("production stateEndpoint must identify one v1.0 SharePoint List resource")
            if "onedrive" in endpoint.lower() or "c:\\users" in endpoint.lower() or endpoint.lower().startswith("file:"):
                raise ConfigurationError("production configuration cannot depend on local or synced paths")
            if raw["resultMaxBytes"] > 8192:
                raise ConfigurationError("production resultMaxBytes must be at most 8192")
        elif role not in {"local-development", "synthetic-test", "manual-fallback"}:
            raise ConfigurationError("non-production runtimeRole is invalid")

        return cls(
            environment_kind=kind, runtime_role=role, environment_id=raw["environmentId"],
            task_namespace=raw["taskNamespace"], lease_domain=raw["leaseDomain"],
            worker_identity=raw["workerIdentity"], hermes_version=raw["hermesVersion"],
            state_backend=raw["stateBackend"], state_endpoint=endpoint,
            result_max_bytes=raw["resultMaxBytes"],
            vm_provider=vm_provider, graph_authentication=graph_authentication,
        )

    @property
    def fingerprint(self) -> str:
        value: dict[str, Any] = {
            "environmentKind": self.environment_kind,
            "runtimeRole": self.runtime_role,
            "environmentId": self.environment_id,
            "taskNamespace": self.task_namespace,
            "leaseDomain": self.lease_domain,
            "workerIdentity": self.worker_identity,
            "hermesVersion": self.hermes_version,
            "stateBackend": self.state_backend,
            "stateEndpoint": self.state_endpoint,
            "resultMaxBytes": self.result_max_bytes,
        }
        if self.vm_provider is not None:
            value["vmProvider"] = self.vm_provider
        if self.graph_authentication is not None:
            value["graphAuthentication"] = self.graph_authentication.as_mapping()
        return fingerprint(value)
