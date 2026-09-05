from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlparse

from .contracts import fingerprint


class ConfigurationError(ValueError):
    pass


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

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> "RuntimeConfig":
        required = {
            "environmentKind", "runtimeRole", "environmentId", "taskNamespace", "leaseDomain",
            "workerIdentity", "hermesVersion", "stateBackend", "stateEndpoint", "resultMaxBytes",
        }
        if set(raw) != required:
            raise ConfigurationError("runtime configuration fields must exactly match the Phase 1 schema")
        for field in required - {"resultMaxBytes"}:
            if not isinstance(raw[field], str) or not raw[field].strip():
                raise ConfigurationError(f"{field} must be a non-empty string")
        if not isinstance(raw["resultMaxBytes"], int) or isinstance(raw["resultMaxBytes"], bool) or raw["resultMaxBytes"] < 1024:
            raise ConfigurationError("resultMaxBytes must be an integer of at least 1024")

        kind = raw["environmentKind"]
        role = raw["runtimeRole"]
        namespace = raw["taskNamespace"].lower()
        lease_domain = raw["leaseDomain"].lower()
        endpoint = raw["stateEndpoint"]
        if kind not in {"development", "test", "production"}:
            raise ConfigurationError("environmentKind is invalid")
        if kind != "production" and (namespace.startswith("prod") or lease_domain.startswith("prod")):
            raise ConfigurationError("non-production runtime cannot address a production task namespace or lease domain")
        if kind == "production":
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
        )

    @property
    def fingerprint(self) -> str:
        return fingerprint(
            {
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
        )
