# Runtime and VM qualification

## Deployment mechanism

The intended mechanism is a narrow manual release to the existing Hermes VM:

1. an authorized operator checks out the independently accepted commit under `/opt/sandiva/hermes-build-steward`;
2. the operator creates a Python virtual environment and installs this package without third-party runtime dependencies;
3. the operator places non-secret configuration at `/etc/sandiva-hermes/runtime.json`;
4. the VM managed identity receives the approved resource-specific Graph grants;
5. the operator installs `deploy/hermes-build-steward-health.service`, runs the synthetic qualification below, and preserves its output as audit evidence;
6. production task consumption remains disabled until separate acceptance and activation authority is given.

This repository does not contain an automatic deployment workflow and Hermes has no deployment authority.

## Health

The hardened systemd unit exposes only `GET http://127.0.0.1:8787/healthz`. It exposes version, configuration fingerprint, environment/worker identity, heartbeat time, current task and lease, pending visibility, last success/failure, and state dependency health. It has no task mutation endpoint. Remote operator visibility should be supplied by the VM's approved monitoring or administration plane, not a partner laptop or a public listener.

## Synthetic VM qualification

Prerequisites:

- run on the existing authoritative Hermes VM, with partner laptop and local Hermes offline;
- Docker-compatible containment available on the VM;
- one approved, preloaded Python verification image pinned by `@sha256:`;
- a dedicated runtime list configured as described in the README;
- a unique synthetic/non-client Build Task whose `auditMetadata.classification` is exactly `synthetic-non-client`;
- that dedicated task contains exactly these acceptance criteria and no unrelated build criterion: `VMQ-RUNAWAY-TERMINATION`, `VMQ-CONTAINER-CLEANUP`, `VMQ-RESTART-RECOVERY`, `VMQ-LEASE-FENCING`, `VMQ-SECRET-ISOLATION`, `VMQ-FILESYSTEM-ISOLATION`, `VMQ-NETWORK-ISOLATION`, `VMQ-NORMAL-VERIFICATION`, and `VMQ-DURABLE-STATE-RECOVERY`;
- that task's `executorPolicy.approvedCommands` must contain the exact entries `python runaway.py` and `python probe.py`;
- canonical synthetic specification and acceptance-contract files whose SHA-256 values match that task.

Phase 1 deliberately terminates its process after leaving a durable `VERIFYING` attempt:

```bash
PYTHONPATH=src python qualification/run_vm_qualification.py prepare \
  --config /etc/sandiva-hermes/runtime.json \
  --task /var/tmp/hermes-qualification/task.json \
  --specification /var/tmp/hermes-qualification/specification.md \
  --acceptance-contract /var/tmp/hermes-qualification/acceptance.md \
  --image 'approved-python-image@sha256:approved-digest'
```

Exit code `42` is intentional. Preserve the JSON line, restart the coordinator/service, wait until the five-second lease is expired, and run:

```bash
PYTHONPATH=src python qualification/run_vm_qualification.py recover \
  --config /etc/sandiva-hermes/runtime.json \
  --task /var/tmp/hermes-qualification/task.json \
  --specification /var/tmp/hermes-qualification/specification.md \
  --acceptance-contract /var/tmp/hermes-qualification/acceptance.md \
  --image 'approved-python-image@sha256:approved-digest'
```

The preparation phase durably records the coordinator-observed runaway termination and container cleanup before intentional exit. The recovery phase resolves those checkpoints, restart/reconciliation, the new lease/fence, durable-state recovery, and four distinct isolated-job observations into separate evidence identities. Each qualification criterion references only its specific record; the script rejects a missing, extra, or unevaluated criterion instead of manufacturing a contract-wide PASS.

The second phase must show attempt count `2`, a larger fencing token, all isolation probes `true`, and final state `READY_FOR_PM_ACCEPTANCE`. Inspect the list item/version history to confirm the earlier attempt, lease, fence, qualification checkpoint, ambiguous recovery, takeover, result, and audit remained durable with no duplicate result.

Local unit tests and command construction are implementation evidence only. They must not be reported as actual VM qualification.
