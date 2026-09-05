# HERMES-01 acceptance evidence matrix

`LOCAL PASS` below means deterministic implementation evidence exists. It is not PM acceptance. Criteria requiring the actual VM remain `VM PENDING` until the documented qualification is run and independently reviewed.

| Criterion | Local evidence | Qualification state |
|---|---|---|
| AC-01 | Production config requires `authoritative-vm`; local prod namespace is rejected | VM PENDING |
| AC-02 | Separate environment IDs, roles, namespaces, lease domains and backends | LOCAL PASS |
| AC-03 | Production config rejects user/synced paths and uses external Graph state | VM PENDING |
| AC-04 | Production endpoint rejects Windows, file and OneDrive paths | LOCAL PASS |
| AC-05 | SharePoint List CAS adapter and restart-store tests | VM PENDING |
| AC-06 | Strict Build Task validator and canonical JSON schema | LOCAL PASS |
| AC-07 | Two-thread compare-and-swap lease fixture | LOCAL PASS; VM PENDING |
| AC-08 | Monotonic fencing and stale-worker rejection | LOCAL PASS; VM PENDING |
| AC-09 | Immutable task fingerprint, deterministic attempt identity and result dedupe | LOCAL PASS |
| AC-10 | Fresh coordinator reconciles unfinished durable record | LOCAL PASS; VM PENDING |
| AC-11 | Expired `VERIFYING` becomes `REWORK_REQUIRED`, never success | LOCAL PASS |
| AC-12 | Read-only loopback health endpoint contains every required field | LOCAL PASS; VM PENDING |
| AC-13 | Managed identity, secret allowlist/redaction, no job credential propagation | LOCAL PASS; VM PENDING |
| AC-14 | Closed authority envelope denies client-document access and broader powers | LOCAL PASS; permission grant VM PENDING |
| AC-15 | Durable record retains task, attempt, lease/fence, result and audit history | LOCAL PASS; VM PENDING |
| AC-16 | Merge/deploy/spec/code/Partner Decision powers explicitly denied | LOCAL PASS |
| AC-17 | Strict normalized result validation for three dispositions | LOCAL PASS |
| AC-18 | Immutable GitHub commit/check read client and CI evidence fields | LOCAL PASS; live evidence VM PENDING |
| AC-19 | Exact reserved-matter allowlist rejects routine failure escalation | LOCAL PASS |
| AC-20 | PASS stops at `READY_FOR_PM_ACCEPTANCE`; `COMPLETE` is unreachable by Hermes | LOCAL PASS |
| AC-21 | Executor dispatch is false and dispatch capabilities are denied | LOCAL PASS |
| AC-22 | New standalone package/workflow only; final git diff supplies drift evidence | LOCAL PASS subject to final diff review |

## HERMES-01A

| Criterion | Local evidence | Qualification state |
|---|---|---|
| AC-A1 | trusted coordinator modules are outside the untrusted container | LOCAL PASS; VM PENDING |
| AC-A2 | no host environment/state authority mount or token injection | LOCAL PASS; VM PENDING |
| AC-A3 | one read-only input mount; tmpfs workspace; no host config mount | LOCAL PASS; VM PENDING |
| AC-A4 | `--network none` default | LOCAL PASS; VM PENDING |
| AC-A5 | CPU/memory/PID/tmpfs/time/output bounds; runaway tests | LOCAL PASS; VM PENDING |
| AC-A6 | malformed, oversized and forged results rejected before mutation | LOCAL PASS |
| AC-A7 | normalized synthetic job result reaches PM-review state only | LOCAL PASS; VM PENDING |

Fixtures A–X have one named test each in `tests/test_original_fixtures_a_to_x.py`. Actual laptop-offline/VM-active evidence, live resource permissions, live container probes, and real process restart remain VM qualification evidence, not local test claims.
