# EXEC-01 Build Execution Adapter — Architecture and Security Boundary

EXEC-01 adds a build-plane execution path below Hermes without changing Canonical Build Task v1.0 or Hermes acceptance authority. Dispatch is available only to the closed v2.0 task contract. The executor produces an implementation result; GitHub/CI produces external evidence; Hermes independently verifies; the PM alone accepts or returns rework.

## Authority flow

```text
validated Canonical Build Task v2.0 + hash-verified PM/specification/contract content + active Hermes lease/fence
  -> allowlisted fingerprinted executor profile
  -> immutable normalized execution request
  -> CodexExecutionAdapter | ClaudeCodeExecutionAdapter
  -> exact-base isolated workspace and bounded runtime
  -> complete pre-publication inspection
  -> separately trusted least-privilege GitHub publisher
  -> deterministic task branch and draft PR
  -> normalized result and bounded audit record
  -> independent Hermes verification
```

Provider-native invocation, sessions, stop reasons and error shapes remain private to the two concrete adapters. Stable tasks and results contain no provider-native fields.

## Credential and containment model

Raw OpenAI/Codex and Anthropic credentials reside only in the source-controlled, digest-pinned credential-injecting gateway, not in the executor process. The gateway container is built by `runtime/executor-gateway/Dockerfile`; its manifest fixes provider, model, upstream, profile fingerprint, policy fingerprint and implementation digest. The trusted host control path attests that manifest and mints a short-lived HMAC capability bound to one task fingerprint, attempt and profile. The gateway denies cross-profile routes, model substitution, duplicate request replay, excessive requests and oversized request/response bodies before injecting the raw provider credential. Legacy one-shot Responses/Messages backends fail closed because a text API response is not a software-build execution. GitHub publisher authority is held by a different trusted boundary and is never placed in the executor object, request, workspace or environment. Hermes PFX, Graph, Control Tower and durable-state material remain exclusively in the coordinator boundary.

The normalized request carries the exact UTF-8 PM instruction, specification and acceptance-contract content resolved by the trusted coordinator, plus task-derived scope, criteria, evidence policy, evaluation/QA requirements, paths, commands and authority references. All three retrieved artifacts are hash checked before dispatch; the canonicalized execution content has its own request fingerprint. No Control Tower credential is passed to the executor.

Production startup attests that the Docker network is internal, contains exactly the approved gateway peer, and that the gateway container has the configured immutable image digest and network-policy fingerprint. It also runs the pinned image's source-controlled `/opt/sandiva/bin/exec01-runtime attest` operation and compares the observed image, wrapper digest, Codex/Claude executable digest and version, launcher version, model, gateway implementation digest and gateway policy digest with the fingerprint-bound profile. Execution uses a digest-pinned, UID/GID 65532 container with a read-only root, all Linux capabilities dropped, `no-new-privileges`, and explicit CPU, memory, PID, tmpfs-workspace, wall-time and output limits. There are no host mounts. Trusted tar streams seed and export the bounded `/workspace` tmpfs through the reviewed Go runtime; host extraction rejects traversal, duplicate targets, symlink pivots and special entries. Executor-supplied `.git` metadata is discarded; the host-created clone metadata is atomically preserved. Docker socket, host home, OneDrive and unrelated directories are never mounted. Timeout, output limit, lifecycle failure or cancellation removes the container and its descendants; partial exports are removed or rolled back.

The production runtime build adds only the reviewed wrapper to a separately approved digest-pinned provider image. The code-QA build substitutes deterministic Codex and Claude executables while exercising the identical wrapper and JSONL/stream-JSON parsers. Codex uses `codex exec --json`; Claude Code uses print mode with `--output-format stream-json`. Only observed command events are reported, and the runtime does not invent test, path or patch evidence. On the `noexec` workspace, approved scripts run through trusted root-filesystem interpreters; the runtime fixture proves direct execution is denied while an interpreter-driven source edit, assertion and generated output succeed.

## Publication and recovery

Before any commit, push or PR action, the trusted inspector independently enumerates tracked, staged and untracked changes and enforces permitted/prohibited paths, traversal, resolved symlink targets, Git links/submodules, secret/key signatures, binary/generated artifact rules and size bounds. Provider-reported path and digest claims are discarded; only the inspector's recomputed change set enters publication and the durable result, and it is recomputed immediately before publication to deny drift. Publication is task-fingerprint, patch-digest and strict attempt-ownership bound. The separate repository-scoped publisher validates the immutable base and local Git metadata, disables hooks and global/system configuration, rejects repository-controlled filters, credential helpers, URL rewrites and other non-allowlisted config, creates one task commit, uses a nonexistence-bound lease when pushing the deterministic task branch, and creates/reads only an open, draft, unmerged PR to `main`. It has no merge, main-push, deploy, ruleset-bypass, administration, secrets or environment authority.

`ProductionExecutionService` is the concrete composition root used by the `exec-dispatch` and `exec-resume` CLI commands. It binds the canonical repository identity, exact source-repository origin, trusted artifact resolver, two external SharePoint CAS namespaces, both allowlisted profiles, the attested Docker gateway/network, the container runner and the separate GitHub publisher. Every privileged publication or result-persistence checkpoint rereads and revalidates the current Hermes lease/fence. Durable stages make duplicate delivery idempotent. Prepared commits, pushed branches and draft PRs are reconciled only by their originating attempt; a different attempt conflicts rather than rewriting lineage. A worker interrupted while the provider is running is classified `AMBIGUOUS_EXECUTOR_STATE`, never successful. Trusted primary unavailability closes that technical attempt before an exact task-authorized fallback receives a fresh attempt, lease and fence; exhausted profiles remain an operational failure and do not create a Partner Decision.

## Explicit non-authorities

EXEC-01 cannot assert Hermes PASS or `READY_FOR_PM_ACCEPTANCE`, resolve Partner Decisions, merge, deploy, activate production, access client documents, use browser/computer control, alter legal provider routing, or modify LDD/Litigation behavior. Hostinger qualification is a separate PM-authorized gate. HMAC is applied only after `DurableQualificationEvidenceCollector` reads the validated task from its durable authority, correlates the normalized result and trusted audit records from the result store, resolves attempt-bound containment and check records, performs repository-scoped GitHub branch/commit/check and open/draft/unmerged PR readback, and reads exactly one accepted-origin Hermes disposition. Verification independently resolves the same records and requires Hermes disposition exactly `PASS`; a self-contained signed assertion, including signed Hermes `FAIL`, cannot qualify. AC-28 is not executed by code QA.
