from __future__ import annotations

import copy
import threading
from dataclasses import dataclass
from typing import Generic, Protocol, TypeVar


T = TypeVar("T")


class StoreConflict(RuntimeError):
    pass


class RecordNotFound(KeyError):
    pass


@dataclass(frozen=True)
class VersionedRecord(Generic[T]):
    value: T
    etag: str


class StateStore(Protocol[T]):
    def create(self, key: str, value: T) -> VersionedRecord[T]: ...
    def get(self, key: str) -> VersionedRecord[T]: ...
    def compare_and_swap(self, key: str, expected_etag: str, value: T) -> VersionedRecord[T]: ...
    def list_records(self) -> list[VersionedRecord[T]]: ...


class InMemoryStateStore(Generic[T]):
    """Thread-safe CAS store for tests only; never a production authority."""

    def __init__(self):
        self._values: dict[str, tuple[int, T]] = {}
        self._lock = threading.Lock()

    def create(self, key: str, value: T) -> VersionedRecord[T]:
        with self._lock:
            if key in self._values:
                raise StoreConflict(f"record already exists: {key}")
            self._values[key] = (1, copy.deepcopy(value))
            return VersionedRecord(copy.deepcopy(value), '"1"')

    def get(self, key: str) -> VersionedRecord[T]:
        with self._lock:
            if key not in self._values:
                raise RecordNotFound(key)
            version, value = self._values[key]
            return VersionedRecord(copy.deepcopy(value), f'"{version}"')

    def compare_and_swap(self, key: str, expected_etag: str, value: T) -> VersionedRecord[T]:
        with self._lock:
            if key not in self._values:
                raise RecordNotFound(key)
            version, _ = self._values[key]
            if expected_etag != f'"{version}"':
                raise StoreConflict(f"etag conflict for {key}")
            version += 1
            self._values[key] = (version, copy.deepcopy(value))
            return VersionedRecord(copy.deepcopy(value), f'"{version}"')

    def list_records(self) -> list[VersionedRecord[T]]:
        with self._lock:
            return [VersionedRecord(copy.deepcopy(value), f'"{version}"') for version, value in self._values.values()]
