# EXEC-01 Build Execution Adapter — Architecture and Security Boundary

EXEC-01 adds a build-plane execution path below Hermes without changing Canonical Build Task v1.0 or Hermes acceptance authority. Dispatch is available only to the closed v2.0 task contract. The executor produces an implementation result; GitHub/CI produces external evidence; Hermes independently verifies; the PM alone accepts or returns rework.

## Authority flow

```text
validated Canonical Build Task v2.0 + active Hermes lease/fence
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

Raw OpenAI/Codex and Anthropic credentials reside at a trusted filtered egress gateway, not in the executor process. The executor receives only task identity, profile identity and an endpoint allowlist. Its environment is constructed empty-by-default and does not inherit the host. GitHub publisher authority is held by a separate gateway and is never placed in the executor object, request, workspace or environment. Hermes PFX, Graph, Control Tower and durable-state material remain exclusively in the coordinator boundary.

Execution uses a digest-pinned, non-root container with a read-only root, all Linux capabilities dropped, `no-new-privileges`, a dedicated filtered network, and explicit CPU, memory, PID, workspace, wall-time and output limits. The only mounts are the task workspace and sealed read-only request. Docker socket, host home, OneDrive and unrelated directories are not mounted. Timeout or output-limit termination kills the process tree.

## Publication and recovery

Before any commit, push or PR action, the trusted inspector enumerates tracked, staged and untracked changes and enforces permitted/prohibited paths, traversal, resolved symlink targets, Git links/submodules, secret/key signatures, binary/generated artifact rules and size bounds. Publication is task-fingerprint and patch-digest bound. The publisher can create a task commit, push only the deterministic task branch, create/read a draft PR and read task metadata. It has no merge, main-push, deploy, administration, secrets or environment authority.

Every privileged publication or result-persistence checkpoint revalidates the current lease/fence. Durable stages make duplicate delivery idempotent. Prepared commits, pushed branches and draft PRs are reconciled by deterministic identities after restart. A worker interrupted while the provider is running is classified `AMBIGUOUS_EXECUTOR_STATE`, never successful. Retry requires a new explicit attempt and remains bounded by the immutable task policy. Fallback is ordered only when the task names exact alternate profile fingerprints and `noDowngrade` remains true.

## Explicit non-authorities

EXEC-01 cannot assert Hermes PASS or `READY_FOR_PM_ACCEPTANCE`, resolve Partner Decisions, merge, deploy, activate production, access client documents, use browser/computer control, alter legal provider routing, or modify LDD/Litigation behavior. Hostinger qualification is a separate PM-authorized gate. The provided qualification validator accepts only synthetic non-client evidence, exact deployed profile fingerprints, draft/unmerged PR readback, and an independent Hermes disposition.
