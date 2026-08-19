# AI-02 Stage 1 Queue/Lifecycle Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral, disabled queue/lifecycle handoff that processes immutable DOCX/TXT source revisions with the existing Stage 0 runner and cannot affect authoritative extraction.

**Architecture:** The primary path may hand a copied byte/revision acquisition to a disabled-by-default asynchronous publisher. The publisher stores bytes behind a tenant-scoped immutable pointer and queues only a content-free envelope; a dedicated worker claims an idempotency record under a renewable lease, resolves the exact pointer/revision, invokes the existing Stage 0 observer, and records retry, dead-letter, or completion state. All production adapters remain disabled and no existing extraction route calls the handoff.

**Tech Stack:** TypeScript, Node.js, Vitest, Next.js 14, existing MarkItDown Stage 0 runner.

## Global Constraints

- Production shadow activation and non-zero production sampling remain disabled.
- Support only DOCX and TXT; exclude PDFs and Graph webhook ingestion.
- Do not change authoritative extraction behavior, outputs, cache behavior, or combined blobs.
- Queue messages contain pointers and privacy-safe identifiers only, never document bytes, names, paths, or extracted text.
- A source pointer is immutable and bound to tenant, revision, size, and SHA-256 content digest.
- Duplicate delivery must never create duplicate Stage 0 processing for the same tenant/source/revision/converter version.
- Failure, timeout, and queue behavior must fail open relative to primary extraction.

---

### Task 1: Immutable acquisition and queue contracts

**Files:**
- Create: `sln-litigation-drafter/lib/document-shadow-stage1/contracts.ts`
- Test: `sln-litigation-drafter/tests/document-shadow-stage1.test.ts`

**Interfaces:**
- Produces: `acquireImmutableSource`, `ShadowSourcePointer`, `ShadowEnvelope`, `ShadowPublisher`, `ShadowQueue`, `ShadowObjectStore`.

- [ ] Write tests that require copied source bytes, literal revision/digest matching, tenant-bound resolution, and a pointer-only serialized envelope.
- [ ] Run the targeted test and verify it fails because the module does not exist.
- [ ] Implement the minimal immutable acquisition, envelope builder, and interfaces.
- [ ] Run the targeted test and verify it passes.

### Task 2: Disabled publisher, configuration, and privacy-safe metrics

**Files:**
- Create: `sln-litigation-drafter/lib/document-shadow-stage1/config.ts`
- Create: `sln-litigation-drafter/lib/document-shadow-stage1/publisher.ts`
- Create: `sln-litigation-drafter/lib/document-shadow-stage1/metrics.ts`
- Modify: `sln-litigation-drafter/tests/document-shadow-stage1.test.ts`

**Interfaces:**
- Consumes: immutable acquisition and provider interfaces from Task 1.
- Produces: `loadStage1Config`, `createDisabledShadowPublisher`, `createShadowPublisher`, `Stage1Metric`.

- [ ] Write tests proving default disablement, zero sampling, kill-switch behavior, no storage/queue calls while disabled, and allowlisted content-free metrics.
- [ ] Run the targeted tests and verify expected assertion failures.
- [ ] Implement the minimal config, disabled publisher, active dependency-injected publisher, and metric schema.
- [ ] Run the targeted tests and verify they pass.

### Task 3: Idempotency, leases, retry, and dead-letter lifecycle

**Files:**
- Create: `sln-litigation-drafter/lib/document-shadow-stage1/lifecycle.ts`
- Modify: `sln-litigation-drafter/tests/document-shadow-stage1.test.ts`

**Interfaces:**
- Produces: `ShadowLifecycleStore`, `InMemoryShadowLifecycleStore`, `claimShadowWork`, and terminal/retry states.

- [ ] Write tests for first claim, duplicate delivery, active lease rejection, expired lease recovery, retry scheduling, maximum-attempt dead-lettering, and tenant-isolated idempotency keys.
- [ ] Run the targeted tests and verify expected failures.
- [ ] Implement the minimal state machine with injected clock and atomic store operations.
- [ ] Run the targeted tests and verify they pass.

### Task 4: Dedicated worker and failure containment

**Files:**
- Create: `sln-litigation-drafter/lib/document-shadow-stage1/worker.ts`
- Create: `sln-litigation-drafter/workers/document-shadow-worker.ts`
- Modify: `sln-litigation-drafter/tests/document-shadow-stage1.test.ts`

**Interfaces:**
- Consumes: queue envelope, object store, lifecycle store, Stage 0 `observeDocumentShadow`.
- Produces: `createShadowWorker`, `runShadowWorkerOnce`.

- [ ] Write tests proving exact revision/digest resolution, duplicate suppression, lease expiry recovery, retry/dead-letter behavior, kill-switch acknowledgement, timeout/cancellation containment, and cross-tenant pointer rejection.
- [ ] Run the targeted tests and verify expected failures.
- [ ] Implement the worker with an abortable timeout and Stage 0 dependency injection.
- [ ] Run the targeted tests and verify they pass.

### Task 5: Disabled deployment definition and authoritative-path regression proof

**Files:**
- Create: `sln-litigation-drafter/deploy/document-shadow-worker.disabled.json`
- Modify: `sln-litigation-drafter/tests/document-normalizer.test.ts`
- Modify: `sln-litigation-drafter/tests/document-shadow-stage1.test.ts`

**Interfaces:**
- Deployment definition declares zero instances, disabled publisher/worker, zero sampling, retention, retry, lease, and kill-switch defaults.

- [ ] Add behavior tests proving publishing is detached/fail-open and the normalizer's primary extraction, cache operations, combined output facade, and user-visible return values are unchanged.
- [ ] Run targeted tests and verify the new assertions fail before wiring the detached facade method.
- [ ] Add only a fire-and-forget Stage 1 facade method backed by the disabled publisher; do not call it from extraction routes.
- [ ] Run targeted tests and verify they pass.

### Task 6: Verification and publication

**Files:**
- Review every changed file and the complete branch diff.

- [ ] Run targeted Stage 1 and compatibility tests.
- [ ] Run the full Vitest suite and record exact test/file counts.
- [ ] Run `npx tsc --noEmit` and record exit status.
- [ ] Run the production build and record exit status.
- [ ] Run `git diff --check`, inspect `git diff --stat`, and verify no out-of-scope files or activation values.
- [ ] Stage only scoped files, commit, push the branch, and open one draft PR titled `AI-02: add disabled queue/lifecycle integration for immutable shadow handoff` without merging.
