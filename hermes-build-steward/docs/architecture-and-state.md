# Architecture and durable state

## Trusted/untrusted boundary

The trusted coordinator alone validates Build Tasks, reads canonical evidence, obtains short-lived credentials, owns durable state, issues leases/fencing tokens, validates results, and changes state. Repository code is copied from one read-only input mount into a size-bounded in-container tmpfs workspace. It receives no host environment, coordinator token, durable-state capability, Docker socket, host secret/config mount, merge credential, or deployment credential.

Verification defaults to `--network none`. Dependency installation is therefore not assumed. The coordinator should consume an approved deterministic GitHub CI result when it already proves the required check. A future egress allowlist is outside this implementation and requires a separate reviewed policy change.

## State technology

A dedicated SharePoint List is the Phase 1 production state authority. This is the smallest CAS-capable mechanism available inside Sandiva's existing Microsoft 365 boundary:

- the task key is unique;
- each write supplies the last observed ETag in `If-Match`;
- HTTP 409/412 becomes a closed conflict and the coordinator retries from fresh state;
- task, attempt, lease/fencing, audit, recovery, and result data live in one versioned item;
- SharePoint versioning supplies an additional operator-visible change history.

The VM filesystem and local Hermes SQLite databases are never production authorities. `InMemoryStateStore` exists only for deterministic tests.

Microsoft documents conditional SharePoint list-item field updates using the list item ETag and `If-Match`; a mismatch returns `412 Precondition Failed`. The runtime list must enforce unique values on `TaskKey` so duplicate delivery cannot create a second authoritative record.

## State and disposition

`CREATED → READY → LEASED → VERIFYING` is the normal path. A validated `PASS` ends at `READY_FOR_PM_ACCEPTANCE`; `FAIL` ends at `REWORK_REQUIRED`; a genuine reserved matter ends at `PARTNER_DECISION_REQUIRED`.

`COMPLETE` exists in the canonical Phase 1 vocabulary but Hermes has no transition into it. Completion is an external PM/acceptance authority action. Invalid transitions fail closed.

An expired unstarted lease returns to `READY`. An expired `VERIFYING` attempt is ambiguous and is reconciled to `REWORK_REQUIRED`; it is never treated as successful. A later claim receives a new deterministic attempt ID and a strictly larger fencing token. Any older worker is rejected.

## Idempotency

Task identity is `taskNamespace + taskId + taskVersion`. The immutable task fingerprint detects conflicting duplicate delivery. Attempt identity is UUIDv5 over task identity plus the monotonic attempt number. Duplicate results for the same attempt are accepted only when their normalized byte representation is identical; a conflicting result fails closed.
