# Sandiva Hermes Build Steward — Phase 1

This package is the Sandiva-specific trusted coordinator required by HERMES-01/HERMES-01A and the provider-neutral build-plane adapter required by EXEC-01. It remains a small companion to the upstream Hermes Agent runtime, not a fork, replacement, deployment controller, or legal-workflow component.

The implementation is not a production gate. A `PASS` means that validated evidence is ready for PM acceptance review; it never accepts, merges, deploys, or activates anything.

## Implementation boundary

Repository inspection found the existing local Hermes installation at `AppData/Local/hermes/hermes-agent`, based on `NousResearch/hermes-agent` v0.21.0. Its current state is local SQLite and its active connection is local-only. The Partner has confirmed that the existing sole authoritative production-target Hermes VM is hosted on Hostinger. No separate Sandiva-owned Hermes repository was accessible from the build environment.

The canonical relationship is therefore:

```text
amengko-stack/sandiva/hermes-build-steward   Sandiva task/state/security contract
                    |
                    v
existing Hermes VM runtime                   sole production-target runtime
                    |
                    v
ephemeral digest-pinned container             untrusted verification only
```

The component lives in `amengko-stack/sandiva` because the Build Task contract, repository permission envelope, CI evidence, and acceptance evidence must version with the canonical Sandiva code baseline. Upstream Hermes remains independently maintained and is not duplicated here.

## Implemented capabilities

- strict Canonical Build Task v1 validation, immutable base/hash validation, complete criterion evidence-authority policy, and permitted/prohibited path enforcement;
- explicit fail-closed Phase 1 state machine;
- compare-and-swap task state, exclusive leases, expiry, renewal, monotonic fencing, deterministic attempt IDs, and duplicate delivery/result handling;
- external SharePoint List state adapter using unique task keys and `If-Match` ETags;
- restart reconciliation that never assumes ambiguous verification succeeded;
- production/development identity, namespace, lease-domain, and backend separation;
- provider-neutral Graph token acquisition, with Entra certificate app-only authentication selected for the Hostinger production VM and optional Azure managed-identity support retained as an independent adapter;
- read-only, host-allowlisted Control Tower and GitHub evidence clients;
- closed least-privilege authority envelope;
- digest-pinned, network-denied, capability-dropped, read-only-root Docker job construction with CPU, memory, process, disk, output, and time bounds;
- strict size-bounded normalized result ingestion with unique evidence identities, exact criterion-to-evidence resolution, acquisition-path trust stamping, and task-bound origin/kind authorization;
- operator health endpoint on `127.0.0.1:8787/healthz`;
- audit/provenance retained with the durable task record and recursive secret-field redaction.
- an explicit Canonical Build Task v2.0 dispatch contract while accepted v1.0 remains non-dispatch;
- fingerprinted Codex and Claude Code profiles behind one normalized `ExecutionAdapter` boundary;
- exact hash-verified PM/specification/acceptance content, task scope, criteria and QA requirements carried read-only in the normalized request;
- source-controlled reproducible executor-wrapper and credential-gateway images, explicit Codex JSONL and Claude stream-JSON parsing, observed profile attestation and deterministic protocol emulators;
- exact-base attempt workspaces, executor/control-plane credential separation, explicit network/resource containment, and complete pre-publication enforcement;
- a concrete `exec-dispatch`/`exec-resume`/`exec-cancel` production composition path with external CAS execution/result stores, exact trusted-source origin verification and task-bound forced container removal;
- no-host-mount, non-root, quota-backed container execution through one attested internal-network gateway, with host-created Git metadata preserved across export;
- deterministic task-bound draft-PR publication through a separate repository-scoped publisher that disables repository hooks/config injection; and
- CAS-shaped execution checkpoints, duplicate idempotency, stale-fence denial, explicit new-attempt ordered fallback, strict publication-attempt ownership, crash reconciliation and bounded provenance;
- trusted qualification evidence acquisition before signing, with independent resolution and Hermes `PASS` mandatory.

## Deliberate exclusions

There is no automatic rework approval, automatic merge, deployment, production activation, client-document access, browser/computer use, AI-01, AI-02, Capability Router, Legal Execution Adapter, or Evaluation Harness. No specialist LDD or Litigation code is imported or changed. Actual Codex/Claude Hostinger execution remains a separate synthetic qualification gate.

## Local deterministic checks

From this directory:

```powershell
$env:PYTHONPATH='src'
python -m unittest discover -s tests -v
python -m compileall -q src tests qualification
```

The A–X fixtures are in `tests/test_original_fixtures_a_to_x.py`. HERMES-01A deterministic boundary tests are in `tests/test_isolation.py` and `tests/test_authority_identity_runner.py`. Hostile forged-result fixtures F1–F7, plus origin/kind and semantic-channel checks, are in `tests/test_result_evidence_integrity.py`. Criterion-authority fixtures G1–G9, task-fingerprint binding, and pre-retrieval CI authorization are in `tests/test_criterion_evidence_policy.py`. Hostinger authentication fixtures HA-01–HA-10 are in `tests/test_hostinger_authentication.py`.

These local tests do not constitute VM qualification. See `docs/runtime-and-vm-qualification.md` for the two-phase synthetic VM procedure.

EXEC-01 architecture and criterion evidence are documented in `docs/exec-01-architecture-and-security.md` and `docs/exec-01-acceptance-evidence.md`. Its 31 hostile fixtures are individually named in `tests/test_exec01_hostile_fixtures.py`; R1–R8 and Q1–Q27 are distributed across the `test_exec01_*`, runtime, gateway, publisher and recovery suites plus the source-controlled Go runtime tests. The Linux-only Docker runtime tests are mandatory in GitHub Actions: CI explicitly installs Go, asserts a working Docker daemon and therefore cannot silently skip them. The later, separately authorized Hostinger evidence gate is `qualification/run_exec01_vm_qualification.py`.

## Runtime configuration

`config/production.example.json` documents the schema. Production must explicitly select `vmProvider: hostinger` and `graphAuthentication.provider: entra-certificate`. Before qualification, an authorized infrastructure operator must replace the tenant, application, SharePoint site, and dedicated runtime-list identifiers. The certificate file is external runtime state and must be readable only by the trusted `sandiva-hermes` service account. The dedicated list is runtime state, not the Control Tower, and this build does not provision or modify it.

`config/exec01-production.example.json` separately documents the EXEC-01 composition schema. It is deliberately non-deployable: every executor/gateway image and executable digest is a zero/placeholder value, and the builder refuses to start until an authorized operator replaces them with the exact approved immutable artifacts, supplies the external trusted GitHub askpass helper, configures distinct execution/result SharePoint Lists, and starts the single approved gateway on the internal Docker network. Executor containers receive no Graph, Hermes, provider or GitHub publisher credential.

`config/exec01-qualification.example.json` documents the closed production evidence-reader configuration. `plan` is read-only and requires only the approved profile manifest. `collect` reconstructs requests and validates authoritative task, execution, result, audit, probe, GitHub and Hermes records before writing a signed package. `verify` reconstructs the same concrete resolver and refuses a package that is self-contained, incomplete or inconsistent. These commands do not dispatch providers or activate Hermes; using them for AC-28 requires separate PM authorization.

The list must have these internal column names:

- `Title` — single line of text;
- `TaskKey` — single line of text, indexed, unique values enforced;
- `TaskNamespace` — single line of text;
- `EnvironmentId` — single line of text;
- `TaskStatus` — single line of text;
- `Payload` — multiple lines of plain text; the adapter enforces a conservative 60,000-character ceiling.

To keep the complete task, audit, and retry history inside that bounded field, the validator limits a Canonical Build Task to 8,192 bytes and three attempts, and production limits each normalized result to 8,192 bytes. The adapter checks the final serialized record before every write and fails closed instead of truncating it.

The service refuses production configuration unless it uses the `authoritative-vm` role, a production namespace and lease domain, and a Microsoft Graph SharePoint List endpoint. A Hostinger configuration using Azure managed identity, an unsupported authentication provider, or an incomplete certificate identity fails closed. Local, file, Windows-user, and OneDrive endpoints fail closed.
