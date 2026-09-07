# EXEC-01 Acceptance Evidence

Canonical contract: `EXEC-01-Build-Execution-Adapter-Phase-1-Build-Specification-and-Acceptance-Contract-v1.md`, SharePoint version 1.0, 23,786 bytes, SHA-256 `527dcd77c93ffc75482ca5633469d455d83f38351c6183e67d3ca2aee88ebad0`.

Authorized base: `9ef9143479090bedc698b77fa7bf2cbc70b37b16`. This repository does not contain or modify the canonical contract.

## Criterion matrix

| AC | Code evidence | Deterministic evidence | Code-QA disposition |
|---|---|---|---|
| AC-01 | `contracts.py`, `coordinator.py`; canonical task v2 schema | v1/v2 task tests; R1 production dispatch; hostile 01–03, 05 | PASS |
| AC-02 | `execution_adapters.py` | adapter conformance tests | PASS |
| AC-03 | `ExecutorProfileRegistry`, `DockerExecutorProfileAttestor`; wrapper/executable/image/gateway identity bound into the profile | Q7; profile tests; hostile 04–05 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-04 | frozen `NormalizedExecutionRequest`; exact hash-verified PM/spec/contract content plus scope, criteria, evaluation, QA and policy envelope | Q1; request fingerprint/content tests; hostile 06 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-05 | `validate_execution_result`; full result schema independently reapplied by the qualification collector | Q19–Q20; Codex/Claude normalization; hostile 27–28 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-06 | `ProductionExecutionService`, `WorkspaceFactory` | R1 real service dispatch, trusted-origin clone, exact-base/reuse/cleanup tests | PASS |
| AC-07 | source-controlled `exec01-gateway`; task/attempt/profile-bound capability; raw credentials exist only in provider-specific trusted proxies; reflected secrets discarded | Q3, Q15, Q21–Q24; hostile 11; Linux R2 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-08 | no-mount executor runtime; preserved trusted Git metadata; hook/config-denying publisher | publisher hook/URL-rewrite probe; hostile 12–15; Linux R2 | PASS; CURRENT-HEAD LINUX CI PASS |
| AC-09 | internal network with no default route and exactly one attested, digest-pinned source gateway; separate gateway-upstream network | Q3, Q21–Q24; policy/attestation tests; hostile 17; Linux R4 probes | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-10 | bounded tmpfs/container/runner and explicit `exec-cancel` | hostile 18–19; local descendant termination; Linux R3 quota/cancellation | PASS; CURRENT-HEAD LINUX CI PASS |
| AC-11 | `PrepublicationInspector`; trusted diff replacement and pre-publish recomputation | R5 omitted/false/overstated claims and drift; hostile 07–10; artifact controls | PASS |
| AC-12 | concrete `GitHubPublisherGateway`; closed `PublisherAuthority`; hardened `SubprocessGit` | R6 immutable readback and malicious Git metadata tests; hostile 12, 30–31 | PASS |
| AC-13 | deterministic branch/PR identity plus strict attempt ownership; open/draft/unmerged readback | Q13–Q14; duplicate/conflict tests; hostile 25–26 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-14 | execution store and publication reconciliation with duplicate record/result/audit/probe rejection | Q20; duplicate test; hostile 20 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-15 | authority callback at privileged checkpoints | stale-fence tests; hostile 21 | PASS |
| AC-16 | `ExecutionCoordinator` staged recovery plus durable fallback-pending state | Q25–Q26 and seven fallback crash boundaries; eight-case recovery matrix; hostile 22–24 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-17 | immutable max-attempt enforcement | recovery retry test | PASS |
| AC-18 | source-controlled `exec01-runtime`; fixed Codex CLI argv; explicit finite-state Codex JSONL parser | Q2, Q4, Q6, Q16, Q24, Q27; Go protocol tests | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW; EXTERNAL BACKEND DEFERRED TO AC-28 |
| AC-19 | source-controlled `exec01-runtime`; fixed Claude Code CLI argv; explicit finite-state stream-JSON parser | Q2, Q5, Q6, Q16, Q24, Q27; Go protocol tests | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW; EXTERNAL BACKEND DEFERRED TO AC-28 |
| AC-20 | stable provider-neutral adapter/result contract; contradictory/missing terminals and raw Responses/Messages objects rejected | Q4–Q6, Q19, Q24, Q27; cross-adapter synthetic equivalence | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-21 | durable trusted primary-unavailability and fallback-pending transition with fresh lease/fence/attempt | Q8–Q9, Q25–Q27; fallback crash/no-downgrade tests; hostile 29 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-22 | result acceptance fixed to `NOT_EVALUATED`; Hermes evidence separately acquired and PASS-only for qualification | Q10–Q12; hostile 28; Hermes F/G regression | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-23 | publisher has no merge/deploy/main authority | hostile 30–31 | PASS |
| AC-24 | diff limited to build-plane Hermes code/docs/tests and its dedicated workflow | 983/983 application regression; scoped diff inspection | PASS |
| AC-25 | accepted Hermes behavior retained | complete 244-test Hermes/EXEC run; includes A–X, F1–F7, G1–G9, HA-01–HA-10, qualification regression and mandatory Linux/Docker runtime fixtures | PASS locally and in current-head Linux CI |
| AC-26 | application/type/build/CI | 983/983 application tests; TypeScript and production build pass; current-head GitHub workflow requires Go and a working Docker daemon | PASS locally and in current-head GitHub checks |
| AC-27 | `build_execution_audit_record`; observed profile, durable fallback and strict publication-attempt provenance | Q7–Q9, Q13, Q20, Q25–Q26; end-to-end provenance tests | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-28 | runnable trusted collect/verify modes; authoritative execution/result/audit/probe and repository-scoped GitHub metadata readback; Hermes PASS mandatory | Q10–Q14, Q17–Q20; actual Hostinger synthetic Codex/Claude qualification | NOT EXECUTED / NOT AUTHORIZED |

## R1–R8 rework regressions

| Regression | Evidence | Local observation |
|---|---|---|
| R1 | `test_r1_production_service_checkout_exact_base_and_reaches_real_adapter` | PASS: v2 Hermes submission reached the selected adapter from an exact-base real clone and cleaned the terminal workspace |
| R2 | `test_r2_non_root_container_reads_request_writes_only_tmpfs_workspace_and_leaves_no_broad_permission` | PASS in Linux/Docker CI; skipped only on the Windows builder |
| R3 | quota and cancellation tests in `test_exec01_docker_runtime.py`; local timeout/output tests | PASS in Linux/Docker CI and local policy/process tests |
| R4 | network attestation unit test and direct-egress Docker probe | PASS in Linux/Docker CI and local policy/attestation tests |
| R5 | adapter diff-discard and runtime trusted-recomputation/drift tests | PASS for omitted, empty, false, overstated and post-inspection drift cases |
| R6 | concrete publisher readback plus malicious hook/URL-rewrite test | PASS; task branch/draft PR metadata is read back and publisher subprocess refuses repository-controlled Git execution config |
| R7 | new coordinator plus external SharePoint CAS recovery test | PASS with no duplicate adapter run, commit, push or PR |
| R8 | signed qualification evidence mutation matrix | PASS for invented PR, wrong commit/base/task/profile, stale fence, duplicate record, self-PASS and unsigned booleans; live AC-28 remains not executed |

## Hostile fixture index

`tests/test_exec01_hostile_fixtures.py` contains 31 separately named tests in canonical order. Each asserts its expected denial, failure classification or idempotent recovery behavior. The final builder report records the observed result for every fixture rather than relying on an aggregate count.

## Q1–Q27 focused rework fixtures

| Fixture | Evidence | Local observation |
|---|---|---|
| Q1 | exact task content and identity mutation test | PASS |
| Q2 | source runtime sealed-request Go test and Linux container test | PASS locally in Go and in Linux/Docker CI |
| Q3 | production composition to source gateway control plane and source gateway image test | PASS locally and in Linux/Docker CI |
| Q4 | Codex JSONL parser plus representative source-runtime container task | PASS locally in Go and in Linux/Docker CI |
| Q5 | Claude Code stream-JSON parser plus equivalent container task | PASS locally in Go and in Linux/Docker CI |
| Q6 | raw OpenAI Responses and Anthropic Messages objects lack valid terminal build protocol | PASS |
| Q7 | observed executable/profile mismatch | PASS: denied before provider invocation |
| Q8 | trusted primary outage and authorized ordered fallback | PASS: fresh attempt and durable failure provenance |
| Q9 | unauthorized/silent fallback | PASS: denied |
| Q10 | signed Hermes FAIL/unresolved/missing/wrong-task/executor-origin evidence | PASS: all denied |
| Q11 | correctly signed but fabricated occurrence claims | PASS: independent acquisition mismatch |
| Q12 | concrete durable-store collector and repository-scoped GitHub branch/PR/check readback | PASS |
| Q13 | publication from another attempt under strict attempt ownership | PASS: conflict |
| Q14 | closed draft PR | PASS: denied |
| Q15 | success/error response floods through Codex and Claude trusted proxies | PASS: reads stop at limit + 1 |
| Q16 | source edit, shell tool, assertion and generated output on noexec workspace | PASS in Linux/Docker CI |
| Q17 | CLI collect/verify with authoritative synthetic stores and concrete resolver | PASS |
| Q18 | evidence verification without resolver/configuration | PASS: fails closed and never prints `QUALIFIED` |
| Q19 | incomplete/schema-invalid normalized result | PASS: rejected before signing |
| Q20 | duplicate execution/result/audit/probe identities | PASS: rejected before indexing |
| Q21 | canonical gateway manifest/profile/policy mismatch matrix | PASS: startup fails closed |
| Q22 | arbitrary upstream scheme/host/path/query/fragment and redirect | PASS: denied |
| Q23 | reflected credential in success or error response | PASS: body discarded; generic denial contains no sentinel |
| Q24 | source runtime to source gateway serve mode to isolated upstream emulator | PASS in Linux/Docker CI for Codex and Claude; direct upstream route and credential-reflection/replay/cross-identity probes denied |
| Q25 | restart after durable primary unavailability before fallback lease | PASS: exact pending fallback claimed |
| Q26 | duplicate dispatch during fallback recovery | PASS: no primary replay or competing attempt |
| Q27 | contradictory/multiple/missing terminal events and unknown failure | PASS in Go: malformed/internal classification; no fallback signal |

## Verification record

The exact local and GitHub Actions observations belong in the current builder handoff so they cannot become stale documentation. The workflow explicitly installs Go, asserts a working Docker daemon, and runs the source runtime/gateway images, so R2–R4, Q2–Q5, Q16 and Q24 cannot be silently skipped. Hostinger evidence is not represented as local or CI evidence and remains deferred.
