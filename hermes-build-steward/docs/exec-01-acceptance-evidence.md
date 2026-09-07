# EXEC-01 Acceptance Evidence

Canonical contract: `EXEC-01-Build-Execution-Adapter-Phase-1-Build-Specification-and-Acceptance-Contract-v1.md`, SharePoint version 1.0, 23,786 bytes, SHA-256 `527dcd77c93ffc75482ca5633469d455d83f38351c6183e67d3ca2aee88ebad0`.

Authorized base: `9ef9143479090bedc698b77fa7bf2cbc70b37b16`. This repository does not contain or modify the canonical contract.

## Criterion matrix

| AC | Code evidence | Deterministic evidence | Code-QA disposition |
|---|---|---|---|
| AC-01 | `contracts.py`, `codec.py`, `sharepoint_store.py`; canonical task v2 schema | Q28–Q31; v1/v2 task tests; R1 production dispatch; hostile 01–03, 05 | PASS in builder code QA; pending independent QA |
| AC-02 | `execution_adapters.py` | adapter conformance tests | PASS |
| AC-03 | `ExecutorProfileRegistry`, `DockerExecutorProfileAttestor`; wrapper/executable/image/gateway identity bound into the profile | Q7; profile tests; hostile 04–05 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-04 | frozen `NormalizedExecutionRequest`; exact hash-verified PM/spec/contract content plus scope, criteria, evaluation, QA, command authority and policy envelope; sealed request drives immutable provider hooks | Q1, Q40–Q41; pre-tool exact-allowlist Go test; real-runtime sentinel fixture; hostile 06 | PASS in builder code QA; pending independent QA |
| AC-05 | `validate_execution_result`; full result schema independently reapplied by the qualification collector; unauthorized commands are denied before invocation and any post-hoc defensive observation remains truthfully recorded | Q19–Q20, Q40–Q41; Go command-observation assertions; Codex/Claude normalization; hostile 27–28 | PASS in builder code QA; pending independent QA |
| AC-06 | `ProductionExecutionService`, `WorkspaceFactory` | R1 real service dispatch, trusted-origin clone, exact-base/reuse/cleanup tests | PASS |
| AC-07 | source-controlled `exec01-gateway`; task/attempt/profile-bound capability; raw credentials exist only in provider-specific trusted proxies; reflected secrets discarded across bounded streams | Q3, Q15, Q21–Q24, Q37–Q39, Q42; hostile 11; Linux R2 | PASS in builder code QA; pending independent QA and exact-head Linux/Docker CI |
| AC-08 | no-mount executor runtime; preserved trusted Git metadata; hook/config-denying publisher | publisher hook/URL-rewrite probe; hostile 12–15; Linux R2 | PASS; CURRENT-HEAD LINUX CI PASS |
| AC-09 | internal network with no default route and exactly one attested, digest-pinned source gateway; separate gateway-upstream network; exact Graph-list pagination boundary | Q3, Q21–Q24, Q42; policy/attestation and malicious-nextLink tests; hostile 17; Linux R4 probes | PASS in builder code QA; pending independent QA and exact-head Linux/Docker CI |
| AC-10 | bounded tmpfs/container/runner and explicit `exec-cancel` | hostile 18–19; local descendant termination; Linux R3 quota/cancellation | PASS; CURRENT-HEAD LINUX CI PASS |
| AC-11 | `PrepublicationInspector`; trusted diff replacement and pre-publish recomputation | R5 omitted/false/overstated claims and drift; hostile 07–10; artifact controls | PASS |
| AC-12 | concrete `GitHubPublisherGateway`; closed `PublisherAuthority`; hardened `SubprocessGit` | R6 immutable readback and malicious Git metadata tests; hostile 12, 30–31 | PASS |
| AC-13 | deterministic branch/PR identity plus strict attempt ownership; open/draft/unmerged readback | Q13–Q14; duplicate/conflict tests; hostile 25–26 | IMPLEMENTED — PENDING INDEPENDENT RE-REVIEW |
| AC-14 | versioned task and execution stores, fallback-state CAS, and publication reconciliation with duplicate record/result/audit/probe rejection | Q20, Q28–Q36; duplicate test; hostile 20 | PASS in builder code QA; pending independent QA |
| AC-15 | authority callback at privileged checkpoints | stale-fence tests; hostile 21 | PASS |
| AC-16 | `ExecutionCoordinator` staged recovery plus durable pending/active fallback identity and expired-attempt reconciliation | Q25–Q26, Q32–Q36 and seven fallback crash boundaries; eight-case recovery matrix; hostile 22–24 | PASS in builder code QA; pending independent QA |
| AC-17 | immutable max-attempt enforcement | recovery retry test | PASS |
| AC-18 | source-controlled `exec01-runtime`; fixed Codex CLI argv/config; immutable Codex `PreToolUse` authorization; explicit finite-state Codex JSONL parser; bounded streaming gateway transport | Q2, Q4, Q6, Q16, Q24, Q27, Q37, Q39–Q40; Go authorization/protocol tests; Linux sentinel fixture | PASS in builder code QA; pending independent QA and exact-head Linux/Docker CI; external backend deferred to AC-28 |
| AC-19 | source-controlled `exec01-runtime`; fixed Claude Code CLI argv/settings; immutable Claude `PreToolUse` authorization; explicit finite-state stream-JSON parser; bounded streaming gateway transport | Q2, Q5, Q6, Q16, Q24, Q27, Q38–Q39, Q41; Go authorization/protocol tests; Linux sentinel fixture | PASS in builder code QA; pending independent QA and exact-head Linux/Docker CI; external backend deferred to AC-28 |
| AC-20 | stable provider-neutral adapter/result contract; contradictory/missing terminals and raw Responses/Messages objects rejected; provider-selected commands require task-bound authorization before invocation | Q4–Q6, Q19, Q24, Q27, Q37–Q41; cross-adapter synthetic equivalence; pre-execution sentinel | PASS in builder code QA; pending independent QA |
| AC-21 | durable trusted primary-unavailability, pending/selected fallback transitions and fresh lease/fence/attempt | Q8–Q9, Q25–Q27, Q32–Q36; fallback crash/no-downgrade tests; hostile 29 | PASS in builder code QA; pending independent QA |
| AC-22 | result acceptance fixed to `NOT_EVALUATED`; complete criterion-authorized Hermes evidence separately acquired, trusted-producer authenticated, exact origin-policy pinned, support-resolved and PASS-only | Q10–Q12, Q31, Q42; fifth-rework provenance adversarial suite; hostile 28; Hermes F/G regression | PASS in builder code QA; pending independent QA |
| AC-23 | publisher has no merge/deploy/main authority | hostile 30–31 | PASS |
| AC-24 | diff limited to build-plane Hermes code/docs/tests and its dedicated workflow | 983/983 application regression; scoped diff inspection | PASS |
| AC-25 | accepted Hermes behavior retained | complete 264-test Hermes/EXEC run (9 Linux/Docker skips on Windows); includes A–X, F1–F7, G1–G9, HA-01–HA-10 and qualification regression | PASS in local builder code QA; exact-head Linux/Docker CI pending |
| AC-26 | application/type/build/CI | 983/983 application tests; application and legacy-root TypeScript and production builds pass | PASS locally; exact-head GitHub checks pending |
| AC-27 | `build_execution_audit_record`; versioned task, observed profile, durable fallback, pre-tool command authority, strict publication-attempt provenance, authenticated evidence producer/store/source identities and exact run/head/type linkage | Q7–Q9, Q13, Q20, Q25–Q36, Q40–Q42; fifth-rework provenance adversarial suite; end-to-end provenance tests | PASS in builder code QA; pending independent QA |
| AC-28 | runnable trusted collect/verify modes; authoritative execution/result/audit/probe and repository-scoped GitHub metadata readback; Hermes PASS mandatory | Q10–Q14, Q17–Q20, Q31, Q42; actual Hostinger synthetic Codex/Claude qualification | NOT EXECUTED / BLOCKED / NOT AUTHORIZED |

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

## Fourth technical closure (Q28–Q42)

This closure keeps AC-28 unavailable to code QA. `CODE_QA_EVIDENCE_VERIFIED` is a
distinct verifier disposition and can never be interpreted as live Hostinger
`QUALIFIED`; only an independently authorized `LIVE_HOSTINGER` run with production
profiles and exact SharePoint authority identities can produce the latter.

| Fixture | Closure evidence | Expected safe result |
|---|---|---|
| Q28 | version-aware `record_from_dict` plus v1/v2 round trip | v2 persists; v1 semantics unchanged |
| Q29 | production SharePoint codec create/get/CAS/list/restart path | exact v2 task and active selection recovered |
| Q30 | canonical encoder/decoder preflight in `_fields` | malformed/mixed task rejected before Graph mutation/token-bearing write |
| Q31 | collector loads an actual `TaskRecord` carrying a v2 task | exact task fingerprint and lease audit used |
| Q32 | `claim_fallback` atomically consumes pending selection | active fallback ID/fingerprint durably bound to lease |
| Q33 | LEASED and VERIFYING codec/recovery path | fallback identity retained through expiry reconciliation |
| Q34 | clock-driven expired fallback recovery | same authorized fallback reselected; primary never replayed |
| Q35 | expired execution-stage production resume plus existing commit/push/PR/result crash matrix | unstarted workspace is reconciled into a bounded new attempt; progressed stages retain/reconcile their durable occurrence without duplicate publication |
| Q36 | provider exhaustion | terminal `FAILED`; duplicates cannot create a new lease |
| Q37 | Codex SSE-style provider transport through bounded proxy | stream forwarded to the source runtime emulator under exact policy |
| Q38 | Claude SSE-style provider transport through the same proxy | same provider-neutral execution contract |
| Q39 | overflow, malformed content, transport failure, redirect and split reflection | generic bounded denial; credential never returned |
| Q40 | Codex unauthorized/malformed command observation | `POLICY_DENIED`; no successful result or publication |
| Q41 | Claude Bash unauthorized/malformed command observation | `POLICY_DENIED`; no successful result or publication |
| Q42 | minimal Hermes PASS, fabricated probe, code-QA-as-live, synthetic production gateway and malicious Graph pagination | fail closed before qualification or credential transmission |

The closure implementation also binds Hermes evidence to the exact task, complete
criterion results, both execution-record fingerprints, an origin-policy fingerprint,
and a recomputed result fingerprint. Containment and check rows are accepted only
when their closed supporting objects recompute to the stored evidence fingerprints.

## Fifth technical closure

The fifth closure moves command authorization in front of execution. Both immutable
provider configurations route every `PreToolUse` event through the source-controlled
runtime. Bash requires an exact match to the sealed task's `approvedCommands`; file
tools are workspace-bounded; malformed and unknown tools fail closed. The deterministic
provider emulators exercise the same authorizer, and the Linux/Docker sentinel test
proves denial occurs before the unauthorized script can modify the repository. Go
parser tests additionally prove that a secondary post-hoc denial cannot conceal a
command that the provider protocol says already ran.

Qualification provenance no longer treats labels plus ordinary SHA-256 as authority.
Probe, check and Hermes rows require the exact configured trusted producer, authoritative
store and evidence source, an external-key HMAC, and closed run/head/task/attempt/profile/
type context. Every check support fingerprint and every Hermes criterion reference must
resolve to independently acquired records before the package is signed. Adversarial
tests reject all-green fabricated probes, missing support, arbitrary Hermes origin policy,
forged source/producer identity, cross-run/head evidence, executor-origin evidence and
post-attestation mutation. AC-28 remains unexecuted and unauthorized.
