from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .config import GraphAuthenticationConfig


GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default"


class GraphTokenAcquisitionError(RuntimeError):
    """A token was not acquired. Details are intentionally not retained."""


class GraphTokenProvider(Protocol):
    def __call__(self) -> str: ...


def _metadata_request(url: str, headers: Mapping[str, str]) -> bytes:
    request = Request(url, headers=dict(headers), method="GET")
    with urlopen(request, timeout=5) as response:
        return response.read()


class AzureManagedIdentityTokenProvider:
    """Obtain a short-lived Graph token from Azure VM managed identity."""

    def __init__(
        self,
        *,
        client_id: str | None = None,
        transport: Callable[[str, Mapping[str, str]], bytes] | None = None,
    ):
        self.client_id = client_id
        self._transport = transport or _metadata_request

    def __call__(self) -> str:
        query = {
            "api-version": "2018-02-01",
            "resource": "https://graph.microsoft.com/",
        }
        if self.client_id:
            query["client_id"] = self.client_id
        url = "http://169.254.169.254/metadata/identity/oauth2/token?" + urlencode(query)
        try:
            payload = json.loads(self._transport(url, {"Metadata": "true"}))
        except Exception:
            raise GraphTokenAcquisitionError("Graph token acquisition failed") from None
        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise GraphTokenAcquisitionError("Graph token acquisition failed")
        return token

    def __repr__(self) -> str:
        return f"AzureManagedIdentityTokenProvider(client_id={self.client_id!r})"


# Compatibility for existing callers; new construction uses the neutral factory below.
ManagedIdentityTokenProvider = AzureManagedIdentityTokenProvider


def _msal_application_factory(**kwargs: Any) -> Any:
    try:
        import msal
    except ImportError:
        raise GraphTokenAcquisitionError("Microsoft identity client is unavailable") from None
    return msal.ConfidentialClientApplication(**kwargs)


class EntraCertificateTokenProvider:
    """Acquire a Graph app-only token with an external PKCS#12 certificate."""

    def __init__(
        self,
        *,
        tenant_id: str,
        client_id: str,
        certificate_path: str,
        application_factory: Callable[..., Any] | None = None,
    ):
        self.tenant_id = tenant_id
        self.client_id = client_id
        self._certificate_path = Path(certificate_path)
        self._application_factory = application_factory or _msal_application_factory
        self._validate_certificate()
        try:
            self._application = self._application_factory(
                client_id=self.client_id,
                authority=f"https://login.microsoftonline.com/{self.tenant_id}",
                client_credential={"private_key_pfx_path": str(self._certificate_path)},
                enable_pii_log=False,
            )
        except GraphTokenAcquisitionError:
            raise
        except Exception:
            raise GraphTokenAcquisitionError("Microsoft identity client initialization failed") from None

    def _validate_certificate(self) -> None:
        if self._certificate_path.is_symlink():
            raise GraphTokenAcquisitionError("certificate credential is invalid")
        try:
            metadata = self._certificate_path.stat()
        except OSError:
            raise GraphTokenAcquisitionError("certificate credential is unavailable") from None
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size == 0:
            raise GraphTokenAcquisitionError("certificate credential is invalid")
        if os.name == "posix":
            if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
                raise GraphTokenAcquisitionError("certificate credential permissions are unsafe")
            if not metadata.st_mode & stat.S_IRUSR:
                raise GraphTokenAcquisitionError("certificate credential is unreadable")
            for ancestor in self._certificate_path.parents:
                if ancestor.is_symlink():
                    raise GraphTokenAcquisitionError("certificate credential permissions are unsafe")
                try:
                    ancestor_metadata = ancestor.stat()
                except OSError:
                    raise GraphTokenAcquisitionError("certificate credential is unavailable") from None
                if ancestor_metadata.st_uid not in {0, os.geteuid()}:
                    raise GraphTokenAcquisitionError("certificate credential permissions are unsafe")
                writable_by_others = ancestor_metadata.st_mode & 0o022
                root_owned_sticky_directory = (
                    ancestor_metadata.st_uid == 0 and ancestor_metadata.st_mode & stat.S_ISVTX
                )
                if writable_by_others and not root_owned_sticky_directory:
                    raise GraphTokenAcquisitionError("certificate credential permissions are unsafe")
        elif not os.access(self._certificate_path, os.R_OK):
            raise GraphTokenAcquisitionError("certificate credential is unreadable")

    def __call__(self) -> str:
        try:
            payload = self._application.acquire_token_for_client(scopes=[GRAPH_DEFAULT_SCOPE])
        except Exception:
            raise GraphTokenAcquisitionError("Graph token acquisition failed") from None
        token = payload.get("access_token") if isinstance(payload, Mapping) else None
        if not isinstance(token, str) or not token:
            raise GraphTokenAcquisitionError("Graph token acquisition failed")
        return token

    def __repr__(self) -> str:
        return f"EntraCertificateTokenProvider(tenant_id={self.tenant_id!r}, client_id={self.client_id!r})"


def build_graph_token_provider(
    config: GraphAuthenticationConfig,
    *,
    azure_transport: Callable[[str, Mapping[str, str]], bytes] | None = None,
    certificate_application_factory: Callable[..., Any] | None = None,
) -> GraphTokenProvider:
    if config.provider == "entra-certificate":
        if not config.tenant_id or not config.client_id or not config.certificate_path:
            raise GraphTokenAcquisitionError("certificate authentication configuration is incomplete")
        return EntraCertificateTokenProvider(
            tenant_id=config.tenant_id,
            client_id=config.client_id,
            certificate_path=config.certificate_path,
            application_factory=certificate_application_factory,
        )
    if config.provider == "azure-managed-identity":
        return AzureManagedIdentityTokenProvider(client_id=config.client_id, transport=azure_transport)
    raise GraphTokenAcquisitionError("unsupported Graph token provider")
