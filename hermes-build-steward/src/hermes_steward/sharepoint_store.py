from __future__ import annotations

import hashlib
import json
from typing import Callable, Mapping, Protocol
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from .codec import record_from_dict, record_to_dict
from .contracts import canonical_json
from .coordinator import TaskRecord
from .store import RecordNotFound, StoreConflict, VersionedRecord

SHAREPOINT_PAYLOAD_LIMIT_CHARS = 60000


class GraphTransport(Protocol):
    def request(self, method: str, url: str, headers: Mapping[str, str], body: str | None = None) -> tuple[int, Mapping[str, str], bytes]: ...


class UrlLibGraphTransport:
    def request(self, method: str, url: str, headers: Mapping[str, str], body: str | None = None) -> tuple[int, Mapping[str, str], bytes]:
        request = Request(url, data=body.encode("utf-8") if body is not None else None, headers=dict(headers), method=method)
        try:
            with urlopen(request, timeout=30) as response:
                return response.status, dict(response.headers.items()), response.read()
        except HTTPError as error:
            return error.code, dict(error.headers.items()), error.read()


class SharePointListStateStore:
    """CAS-backed task state using one uniquely keyed SharePoint List item per task version."""

    def __init__(
        self,
        list_endpoint: str,
        task_namespace: str,
        environment_id: str,
        token_provider: Callable[[], str],
        *,
        transport: GraphTransport | None = None,
    ):
        self.list_endpoint = list_endpoint.rstrip("/")
        self.task_namespace = task_namespace
        self.environment_id = environment_id
        self.token_provider = token_provider
        self.transport = transport or UrlLibGraphTransport()

    def _headers(self, *, etag: str | None = None) -> dict[str, str]:
        token = self.token_provider()
        if not token:
            raise RuntimeError("managed identity did not provide a Graph access token")
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"}
        if etag is not None:
            headers["If-Match"] = etag
        return headers

    def _fields(self, key: str, record: TaskRecord) -> dict[str, str]:
        payload = canonical_json(record_to_dict(record)).decode("utf-8")
        if len(payload) > SHAREPOINT_PAYLOAD_LIMIT_CHARS:
            raise ValueError(f"durable task record exceeds the {SHAREPOINT_PAYLOAD_LIMIT_CHARS}-character Payload limit")
        return {
            "Title": hashlib.sha256(key.encode("utf-8")).hexdigest(),
            "TaskKey": key,
            "TaskNamespace": self.task_namespace,
            "EnvironmentId": self.environment_id,
            "TaskStatus": record.status.value,
            "Payload": payload,
        }

    @staticmethod
    def _decode_item(item: Mapping[str, object]) -> VersionedRecord[TaskRecord]:
        fields = item.get("fields")
        etag = item.get("eTag")
        if not isinstance(fields, dict) or not isinstance(fields.get("Payload"), str) or not isinstance(etag, str):
            raise RuntimeError("SharePoint state item is missing Payload or eTag")
        return VersionedRecord(record_from_dict(json.loads(fields["Payload"])), etag)

    def _query_url(self, key: str | None = None) -> str:
        expand = "$expand=fields($select=TaskKey,TaskNamespace,EnvironmentId,TaskStatus,Payload)&$top=999"
        if key is None:
            return f"{self.list_endpoint}/items?{expand}"
        escaped = key.replace("'", "''")
        query = f"{expand}&$filter=fields/TaskKey eq '{escaped}'"
        encoded_query = quote(query, safe="$=(),&'")
        return f"{self.list_endpoint}/items?{encoded_query}"

    def _get_item(self, key: str) -> tuple[str, VersionedRecord[TaskRecord]]:
        status, _, raw = self.transport.request("GET", self._query_url(key), self._headers())
        if status != 200:
            raise RuntimeError(f"SharePoint state read failed with HTTP {status}")
        values = json.loads(raw).get("value", [])
        if not values:
            raise RecordNotFound(key)
        if len(values) != 1:
            raise RuntimeError("SharePoint TaskKey uniqueness invariant is violated")
        item = values[0]
        fields = item.get("fields", {})
        if fields.get("TaskNamespace") != self.task_namespace or fields.get("EnvironmentId") != self.environment_id:
            raise RuntimeError("SharePoint state item belongs to a different environment or namespace")
        return str(item["id"]), self._decode_item(item)

    def create(self, key: str, value: TaskRecord) -> VersionedRecord[TaskRecord]:
        body = json.dumps({"fields": self._fields(key, value)}, separators=(",", ":"))
        status, _, raw = self.transport.request("POST", f"{self.list_endpoint}/items", self._headers(), body)
        if status in {409, 412}:
            raise StoreConflict(f"record already exists: {key}")
        if status != 201:
            raise RuntimeError(f"SharePoint state create failed with HTTP {status}")
        return self._decode_item(json.loads(raw))

    def get(self, key: str) -> VersionedRecord[TaskRecord]:
        return self._get_item(key)[1]

    def compare_and_swap(self, key: str, expected_etag: str, value: TaskRecord) -> VersionedRecord[TaskRecord]:
        item_id, current = self._get_item(key)
        if current.etag != expected_etag:
            raise StoreConflict(f"etag conflict for {key}")
        body = json.dumps(self._fields(key, value), separators=(",", ":"))
        status, _, _ = self.transport.request(
            "PATCH", f"{self.list_endpoint}/items/{item_id}/fields", self._headers(etag=expected_etag), body
        )
        if status == 412:
            raise StoreConflict(f"etag conflict for {key}")
        if status != 200:
            raise RuntimeError(f"SharePoint state update failed with HTTP {status}")
        return self._get_item(key)[1]

    def list_records(self) -> list[VersionedRecord[TaskRecord]]:
        url = self._query_url()
        records = []
        while url:
            status, _, raw = self.transport.request("GET", url, self._headers())
            if status != 200:
                raise RuntimeError(f"SharePoint state list failed with HTTP {status}")
            payload = json.loads(raw)
            for item in payload.get("value", []):
                fields = item.get("fields", {})
                if fields.get("TaskNamespace") == self.task_namespace and fields.get("EnvironmentId") == self.environment_id:
                    records.append(self._decode_item(item))
            url = payload.get("@odata.nextLink")
        return records
