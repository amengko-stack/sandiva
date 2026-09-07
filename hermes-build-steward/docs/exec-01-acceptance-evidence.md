# EXEC-01 Acceptance Evidence

Canonical contract: `EXEC-01-Build-Execution-Adapter-Phase-1-Build-Specification-and-Acceptance-Contract-v1.md`, SharePoint version 1.0, 23,786 bytes, SHA-256 `527dcd77c93ffc75482ca5633469d455d83f38351c6183e67d3ca2aee88ebad0`.

Authorized base: `9ef9143479090bedc698b77fa7bf2cbc70b37b16`. This repository does not contain or modify the canonical contract.

## Criterion matrix

| AC | Code evidence | Deterministic evidence | Code-QA disposition |
|---|---|---|---|
| AC-01 | `contracts.py`, `coordinator.py`; canonical task v2 schema | v1/v2 task tests; R1 production dispatch; hostile 01–03, 05 | PASS |
| AC-02 | `execution_adapters.py` | adapter conformance tests | PASS |
| AC-03 | `ExecutorProfileRegistry` | profile tests; hostile 04–05 | PASS |
| AC-04 | frozen `NormalizedExecutionRequest`; request schema | request fingerprint/immutability tests; hostile 06 | PASS |
| AC-05 | `validate_execution_result`; result schema | Codex/Claude normalization; hostile 27–28 | PASS |
| AC-06 | `ProductionExecutionService`, `WorkspaceFactory` | R1 real service dispatch, trusted-origin clone, exact-base/reuse/cleanup tests | PASS |
| AC-07 | `TrustedExecutorGateway`; Codex/Claude gateway backends; empty-by-default executor environment | gateway task/profile binding and credential-reflection tests; hostile 11; Linux R2 | PASS subject to current-head Linux CI |
| AC-08 | no-mount executor runtime; preserved trusted Git metadata; hook/config-denying publisher | publisher hook/URL-rewrite probe; hostile 12–15; Linux R2 | PASS subject to current-head Linux CI |
| AC-09 | internal-network attestation with exactly one digest-pinned gateway | policy/attestation tests; hostile 17; Linux R4 direct-egress probes | PASS subject to current-head Linux CI |
| AC-10 | bounded tmpfs/container/runner and explicit `exec-cancel` | hostile 18–19; local descendant termination; Linux R3 quota/cancellation | PASS subject to current-head Linux CI |
| AC-11 | `PrepublicationInspector`; trusted diff replacement and pre-publish recomputation | R5 omitted/false/overstated claims and drift; hostile 07–10; artifact controls | PASS |
| AC-12 | concrete `GitHubPublisherGateway`; closed `PublisherAuthority`; hardened `SubprocessGit` | R6 immutable readback and malicious Git metadata tests; hostile 12, 30–31 | PASS |
| AC-13 | deterministic branch and PR identity | duplicate/conflict tests; hostile 25–26 | PASS |
| AC-14 | execution store and publication reconciliation | duplicate test; hostile 20 | PASS |
| AC-15 | authority callback at privileged checkpoints | stale-fence tests; hostile 21 | PASS |
| AC-16 | `ExecutionCoordinator` staged recovery | eight-case recovery matrix; hostile 22–24 | PASS |
| AC-17 | immutable max-attempt enforcement | recovery retry test | PASS |
| AC-18 | `CodexExecutionAdapter`, `CodexGatewayBackend` and fingerprinted profile | normalized conformance and exact trusted provider protocol tests | PASS code QA; actual Hostinger backend deferred to AC-28 |
| AC-19 | `ClaudeCodeExecutionAdapter`, `ClaudeGatewayBackend` and fingerprinted profile | normalized conformance and exact trusted provider protocol tests | PASS code QA; actual Hostinger backend deferred to AC-28 |
| AC-20 | stable adapter protocol | cross-adapter synthetic equivalence | PASS |
| AC-21 | ordered exact-profile selection | fallback/no-downgrade tests; hostile 29 | PASS |
| AC-22 | result acceptance fixed to `NOT_EVALUATED` | hostile 28; Hermes F/G regression | PASS |
| AC-23 | publisher has no merge/deploy/main authority | hostile 30–31 | PASS |
| AC-24 | diff limited to build-plane Hermes code/docs/tests and its dedicated workflow | 983/983 application regression; scoped diff inspection | PASS |
| AC-25 | accepted Hermes behavior retained | complete 214-test local Hermes/EXEC run: 210 pass, four Linux/Docker tests skipped locally; includes A–X, F1–F7, G1–G9, HA-01–HA-10 and qualification regression | PASS subject to current-head Linux CI |
| AC-26 | application/type/build/CI | 983/983 application tests; TypeScript and production build pass; CI workflow requires Go and a working Docker daemon | PASS locally; current-head GitHub checks are authoritative for CI |
| AC-27 | `build_execution_audit_record` | end-to-end provenance test | PASS |
| AC-28 | HMAC-attested, task/base/head/profile/fence/PR/Hermes-bound `run_exec01_vm_qualification.py` | actual Hostinger synthetic Codex/Claude qualification | NOT EXECUTED — separate PM authorization required |

## R1–R8 rework regressions

| Regression | Evidence | Local observation |
|---|---|---|
| R1 | `test_r1_production_service_checkout_exact_base_and_reaches_real_adapter` | PASS: v2 Hermes submission reached the selected adapter from an exact-base real clone and cleaned the terminal workspace |
| R2 | `test_r2_non_root_container_reads_request_writes_only_tmpfs_workspace_and_leaves_no_broad_permission` | Linux/Docker only; mandatory in CI, skipped on Windows |
| R3 | quota and cancellation tests in `test_exec01_docker_runtime.py`; local timeout/output tests | local policy/process tests PASS; Linux/Docker tests mandatory in CI |
| R4 | network attestation unit test and direct-egress Docker probe | attestation PASS locally; direct-egress probe mandatory in CI |
| R5 | adapter diff-discard and runtime trusted-recomputation/drift tests | PASS for omitted, empty, false, overstated and post-inspection drift cases |
| R6 | concrete publisher readback plus malicious hook/URL-rewrite test | PASS; task branch/draft PR metadata is read back and publisher subprocess refuses repository-controlled Git execution config |
| R7 | new coordinator plus external SharePoint CAS recovery test | PASS with no duplicate adapter run, commit, push or PR |
| R8 | signed qualification evidence mutation matrix | PASS for invented PR, wrong commit/base/task/profile, stale fence, duplicate record, self-PASS and unsigned booleans; live AC-28 remains not executed |

## Hostile fixture index

`tests/test_exec01_hostile_fixtures.py` contains 31 separately named tests in canonical order. Each asserts its expected denial, failure classification or idempotent recovery behavior. The final builder report records the observed result for every fixture rather than relying on an aggregate count.

## Verification record

Observed locally on the authorized branch during post-QA rework:

- complete Hermes/EXEC suite: 214 tests run, 210 passed, four Linux/Docker tests skipped because Docker is unavailable on the Windows builder;
- hostile matrix: 31 separately named fixtures passed;
- application regression: 62 files and 983 tests passed, preserving the accepted 983/983 baseline;
- TypeScript: `npx.cmd tsc --noEmit` passed;
- production build: Next.js 14.2.35 compiled, typechecked and generated 65/65 static pages;
- Python: compileall passed; all five JSON schemas parsed;
- package: `sandiva_hermes_build_steward-0.2.0-py3-none-any.whl` built, SHA-256 `7893876ca955b5d899ea2f1ccf65cdbb9e35e202febef2e482aae964bab9ca13`;
- diff hygiene: `git diff --check` passed (line-ending notices only).

The current-head GitHub `Hermes Build Steward / deterministic` check is the required Linux/Docker evidence. Its workflow explicitly installs Go and asserts a working Docker daemon before discovery, so R2–R4 cannot be silently skipped there. The `sln-litigation-drafter` check remains the authoritative CI readback for the application suite. Vercel, if triggered by the draft PR, is a non-production preview only and is not production deployment or activation.

Hostinger evidence is not represented as local or CI evidence and remains deferred.
