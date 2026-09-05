from __future__ import annotations

import json
from typing import Callable, Mapping
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def _metadata_request(url: str, headers: Mapping[str, str]) -> bytes:
    request = Request(url, headers=dict(headers), method="GET")
    with urlopen(request, timeout=5) as response:
        return response.read()


class ManagedIdentityTokenProvider:
    """Obtain a short-lived Graph token from Azure VM managed identity; stores no secret."""

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
        payload = json.loads(self._transport(url, {"Metadata": "true"}))
        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("Azure managed identity response did not include an access token")
        return token

    def __repr__(self) -> str:
        return f"ManagedIdentityTokenProvider(client_id={self.client_id!r})"
