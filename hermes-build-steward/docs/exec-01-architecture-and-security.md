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

Raw OpenAI/Codex and Anthropic credentials reside at a separately deployed, digest-pinned trusted egress gateway, not in the executor process. `TrustedExecutorGateway` accepts exactly one task/profile/attempt-bound envelope, selects the profile-controlled provider and model, obtains the provider credential only inside the gateway, bounds time and response size, rejects credential reflection and records only secret-free fingerprints. `CodexGatewayBackend` and `ClaudeGatewayBackend` keep their respective authentication headers and provider protocols behind that boundary. The executor receives only the normalized request, profile identity and the one approved gateway endpoint. Its environment is constructed empty-by-default and does not inherit the host. GitHub publisher authority is held by a different trusted boundary and is never placed in the executor object, request, workspace or environment. Hermes PFX, Graph, Control Tower and durable-state material remain exclusively in the coordinator boundary.

Production startup attests that the Docker network is internal, contains exactly the approved gateway peer, and that the gateway container has the configured immutable image digest and network-policy fingerprint. Execution uses a digest-pinned, UID/GID 65532 container with a read-only root, all Linux capabilities dropped, `no-new-privileges`, and explicit CPU, memory, PID, tmpfs-workspace, wall-time and output limits. There are no host mounts. Trusted tar streams seed and export the bounded `/workspace` tmpfs through the fixed runtime wrapper; host extraction rejects traversal, duplicate targets, symlink pivots and special entries. The normalized request is injected without a host request file, and successful working-tree content is exported before forced container removal. Executor-supplied `.git` metadata is discarded; the host-created clone metadata is atomically preserved. Docker socket, host home, OneDrive and unrelated directories are never mounted. Timeout, output limit, lifecycle failure or cancellation removes the container and its descendants; partial exports are removed or rolled back.

## Publication and recovery

Before any commit, push or PR action, the trusted inspector independently enumerates tracked, staged and untracked changes and enforces permitted/prohibited paths, traversal, resolved symlink targets, Git links/submodules, secret/key signatures, binary/generated artifact rules and size bounds. Provider-reported path and digest claims are discarded; only the inspector's recomputed change set enters publication and the durable result, and it is recomputed immediately before publication to deny drift. Publication is task-fingerprint and patch-digest bound. The separate repository-scoped publisher validates the immutable base and local Git metadata, disables hooks and global/system configuration, rejects repository-controlled filters, credential helpers, URL rewrites and other non-allowlisted config, creates one task commit, uses a nonexistence-bound lease when pushing the deterministic task branch, and creates/reads only a draft PR to `main`. It has no merge, main-push, deploy, ruleset-bypass, administration, secrets or environment authority.

`ProductionExecutionService` is the concrete composition root used by the `exec-dispatch` and `exec-resume` CLI commands. It binds the canonical repository identity, exact source-repository origin, two external SharePoint CAS namespaces, both allowlisted profiles, the attested Docker gateway/network, the container runner and the separate GitHub publisher. Every privileged publication or result-persistence checkpoint rereads and revalidates the current Hermes lease/fence. Durable stages make duplicate delivery idempotent. Prepared commits, pushed branches and draft PRs are reconciled by deterministic identities after restart. A worker interrupted while the provider is running is classified `AMBIGUOUS_EXECUTOR_STATE`, never successful. Retry requires a new explicit attempt and remains bounded by the immutable task policy. Fallback is ordered only when the task names exact alternate profile fingerprints and `noDowngrade` remains true.

## Explicit non-authorities

EXEC-01 cannot assert Hermes PASS or `READY_FOR_PM_ACCEPTANCE`, resolve Partner Decisions, merge, deploy, activate production, access client documents, use browser/computer control, alter legal provider routing, or modify LDD/Litigation behavior. Hostinger qualification is a separate PM-authorized gate. The provided qualification validator accepts only HMAC-attested synthetic non-client evidence bound to the exact task, base/head, deployed profile fingerprints, durable attempts/fences, draft/unmerged PR readback, containment probes and independently sourced Hermes disposition. AC-28 is not executed by code QA.
