# EXEC-01 Acceptance Evidence

Canonical contract: `EXEC-01-Build-Execution-Adapter-Phase-1-Build-Specification-and-Acceptance-Contract-v1.md`, SharePoint version 1.0, 23,786 bytes, SHA-256 `527dcd77c93ffc75482ca5633469d455d83f38351c6183e67d3ca2aee88ebad0`.

Authorized base: `9ef9143479090bedc698b77fa7bf2cbc70b37b16`. This repository does not contain or modify the canonical contract.

## Criterion matrix

| AC | Code evidence | Deterministic evidence | Code-QA disposition |
|---|---|---|---|
| AC-01 | `contracts.py`; canonical task v2 schema | `test_execution_task_contract.py`; hostile 01–03, 05 | PASS |
| AC-02 | `execution_adapters.py` | adapter conformance tests | PASS |
| AC-03 | `ExecutorProfileRegistry` | profile tests; hostile 04–05 | PASS |
| AC-04 | frozen `NormalizedExecutionRequest`; request schema | request fingerprint/immutability tests; hostile 06 | PASS |
| AC-05 | `validate_execution_result`; result schema | Codex/Claude normalization; hostile 27–28 | PASS |
| AC-06 | `WorkspaceFactory` | exact-base and workspace-reuse runtime test | PASS |
| AC-07 | trusted-egress-gateway profiles; empty-by-default environment | real provider sentinel hostile 11 | PASS |
| AC-08 | executor environment and publisher separation | real sentinels hostile 12–15 | PASS |
| AC-09 | `ContainmentPolicy` endpoint allowlist | network probes hostile 17 | PASS |
| AC-10 | bounded container/runner | hostile 18–19; descendant termination tests | PASS |
| AC-11 | `PrepublicationInspector` | hostile 07–10 and artifact controls | PASS |
| AC-12 | `TrustedGitHubPublisher`; closed `PublisherAuthority` | publisher tests; hostile 12, 30–31 | PASS |
| AC-13 | deterministic branch and PR identity | duplicate/conflict tests; hostile 25–26 | PASS |
| AC-14 | execution store and publication reconciliation | duplicate test; hostile 20 | PASS |
| AC-15 | authority callback at privileged checkpoints | stale-fence tests; hostile 21 | PASS |
| AC-16 | `ExecutionCoordinator` staged recovery | eight-case recovery matrix; hostile 22–24 | PASS |
| AC-17 | immutable max-attempt enforcement | recovery retry test | PASS |
| AC-18 | `CodexExecutionAdapter` and fingerprinted profile | synthetic backend conformance | PASS locally; actual backend deferred to AC-28 |
| AC-19 | `ClaudeCodeExecutionAdapter` and fingerprinted profile | synthetic backend conformance | PASS locally; actual backend deferred to AC-28 |
| AC-20 | stable adapter protocol | cross-adapter synthetic equivalence | PASS |
| AC-21 | ordered exact-profile selection | fallback/no-downgrade tests; hostile 29 | PASS |
| AC-22 | result acceptance fixed to `NOT_EVALUATED` | hostile 28; Hermes F/G regression | PASS |
| AC-23 | publisher has no merge/deploy/main authority | hostile 30–31 | PASS |
| AC-24 | diff limited to build-plane Hermes code/docs/tests | 983/983 application regression; scoped diff inspection | PASS |
| AC-25 | accepted Hermes behavior unmodified | complete 193/193 Hermes regression including A–X, F1–F7, G1–G9, HA-01–HA-10 and VM regression | PASS |
| AC-26 | application/type/build/CI | 983/983 application tests; TypeScript, production build, Hermes deterministic CI and application CI pass | PASS |
| AC-27 | `build_execution_audit_record` | end-to-end provenance test | PASS |
| AC-28 | `run_exec01_vm_qualification.py` | actual Hostinger synthetic Codex/Claude qualification | DEFERRED — separate PM authorization required |

## Hostile fixture index

`tests/test_exec01_hostile_fixtures.py` contains 31 separately named tests in canonical order. Each asserts its expected denial, failure classification or idempotent recovery behavior. The final builder report records the observed result for every fixture rather than relying on an aggregate count.

## Verification record

Observed on the authorized branch before publication:

- complete Hermes suite: 193 tests passed;
- hostile matrix: 31 separately named fixtures passed;
- application regression: 62 files and 983 tests passed, preserving the accepted 983/983 baseline;
- TypeScript: `npx.cmd tsc --noEmit` passed;
- production build: Next.js 14.2.35 compiled, typechecked and generated 65/65 static pages;
- Python: compileall passed; all five JSON schemas parsed;
- package: `sandiva_hermes_build_steward-0.2.0-py3-none-any.whl` built, SHA-256 `27db0a9da265664a32eacaecd31881bf1e7504826855e6e987cfa8d733f66534`;
- output-flood regression: repeated ten times after correcting the Windows termination-observation race, all passed;
- diff hygiene: `git diff --check` passed (line-ending notices only).
- draft PR: `https://github.com/amengko-stack/sandiva/pull/85`, open and draft against the exact authorized base;
- GitHub readback: Hermes `deterministic` and `sln-litigation-drafter` checks passed; Vercel preview checks passed. The existing PR integration created only a non-production preview, not production deployment or activation.

Hostinger evidence is not represented as local or CI evidence and remains deferred.
