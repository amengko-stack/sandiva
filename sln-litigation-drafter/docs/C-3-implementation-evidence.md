# C-3 implementation evidence

Build ID: `C-3`

Acceptance Contract: v1

Architecture: ADR-024, preserving ADR-017

Approved baseline: `665b2b68ff17674fb78d75f736761c7a65c40827`

Branch: `fix/c3-litigation-memory-isolation`

This document is an implementation handoff for independent QA. It is not an
approval or acceptance record. The canonical C-3 Acceptance Contract remains
authoritative if any summary below is incomplete.

## Current memory trace

The required pre-implementation object, writer, source, risk, storage, reader,
target scope, authority-key and legacy analysis is in
`docs/C-3-current-memory-flow-trace.md`.

## Implemented boundary

- C-1 `authorizeLitigation` resolves the server registration before any
  protected memory read/write, prompt construction or model call.
- The opaque matter-memory key is SHA-256 over the exact registered SharePoint
  `driveId` and `itemId`; client labels and browser state never select scope.
- Matter records live only below `litigation-memory/matter-memory/<hash>/...`.
- Explicit firm-safe records live only below `litigation-memory/firm-safe/...`
  and must pass the strict firm-safe provenance schema. No production C-3 route
  writes or promotes firm-safe records.
- Stage 3 loads only validated firm-safe and same-matter records.
- Stage 4 scope-filters first and then ranks eligible style records by exact
  document type and claim type, document type, and recency.
- Approval writes the full draft, style index and derived pattern notes only to
  the authorized matter namespace.
- Setup raw samples and derived conventions are matter-scoped. Citation
  extraction uses the same eligible convention boundary.
- Legacy global convention, pattern, index and style objects are preserved but
  are not production inputs.

## Acceptance matrix

| Criterion | Implementation | Behavioral proof | Observed result |
|---|---|---|---|
| AC-01 — Two memory classes | `litigation-memory.ts` validates only `matter` and `firm_safe` records | F, S, V | Matter is the default for client-derived content; firm-safe requires explicit administrative provenance. PASS |
| AC-02 — C-1 matter authority | All protected routes authorize through C-1 before memory access | J-N, T; C-1 suites | Server registration, not request labels or browser values, supplies the matter identity. PASS |
| AC-03 — Matter-scoped storage | Fixed opaque `matter-memory/<64-hex>/...` keys | A, O, R, S | New matter-derived records are written only inside the authorized namespace. PASS |
| AC-04 — Analysis memory isolation | `loadAnalysisMemory(authority)` reads validated firm-safe plus same-matter records | D, P | Captured Matter B Stage 3 prompt has zero Matter A sentinel occurrences; Matter A reuse remains present. PASS |
| AC-05 — Draft memory isolation | `loadDraftMemory(authority, docType, claimType)` filters before ranking | B, C, E, Q, U | Captured Matter B Stage 4 prompt has zero Matter A sentinel occurrences; same-matter ranking is preserved. PASS |
| AC-06 — Approved-draft write isolation | Approval requires session authority and `saveApprovedDraft` receives that authority | A, K, L, S, V | Full draft, index and patterns remain matter-scoped; invalid/cleared sessions write zero bytes. PASS |
| AC-07 — Case-pattern isolation | Pattern collection and extracted notes share the approved draft's matter/provenance | D, S, V | Matter A pattern marker is absent from Matter B analysis and no firm-safe pattern is created. PASS |
| AC-08 — Firm-safe convention reuse | Strict validated firm-safe convention reader | F; citation consumer test | Explicit generic methodology is available across matters; matter and legacy convention text is not. PASS |
| AC-09 — Legacy style fail closed | Production loaders do not read legacy global index/object keys | G | Legacy bytes remain stored and are excluded. PASS |
| AC-10 — Legacy pattern fail closed | Production loaders do not read the legacy global pattern key | H | Legacy pattern marker is absent from the prompt. PASS |
| AC-11 — Legacy convention fail closed | Production loaders do not read `firm_conventions.md` | I; citation consumer test | Legacy convention marker is absent from analysis and citation prompts. PASS |
| AC-12 — Setup-sample isolation | Setup analysis stores raw samples in the authorized matter; convention save requires that session | K, R, S | Raw and derived real-client setup material remains in Matter A and is absent from Matter B/global storage. PASS |
| AC-13 — Provenance | Strict records persist schema, scope, authority, origin/source, creation, workflow, session/run and type metadata | S | Persisted style, pattern and setup records validate the required fields. PASS |
| AC-14 — Authorization ordering | Route calls place C-1 authorization before protected reads/writes and model invocation | J, K, L | Denials perform zero protected memory reads/writes and zero model calls. PASS |
| AC-15 — Ref/type/claim manipulation resistance | Scope key accepts only C-1 authority; metadata is used only after filtering | B, C, M, N | Forged labels cannot select another matter namespace. PASS |
| AC-16 — Traversal and prefix-collision resistance | Storage keys use fixed namespaces, opaque hash and generated record UUIDs | O | Unsafe IDs and client identifiers are inert and no foreign object is read. PASS |
| AC-17 — Prompt-level leakage proof | Tests capture complete Anthropic request objects | P, Q; D, E | Matter B Stage 3/4 requests contain zero sentinel occurrences; positive same-matter controls contain the sentinel. PASS |
| AC-18 — C-1 regression preservation | C-1 authority implementation is unchanged; protected routes consume it | T; complete standalone C-1 suites | Immutable root, registry schema, exact manifest, protected-route isolation and clear semantics remain green. PASS |
| AC-19 — Ranking after scope filtering | Eligible indexes are validated and combined before rank selection | U, B | Exact same-matter match wins while a foreign exact match remains unread and absent. PASS |
| AC-20 — No automatic promotion | Current setup/approval writers can emit matter records only | V, R | Matter content creates no firm-safe key or record. PASS |

## Canonical fixtures

| Fixture | Result | Proof |
|---|---|---|
| A — Same-matter approved-draft reuse | PASS | Matter A record is stored under its opaque namespace and appears in A's captured draft prompt. |
| B — Cross-matter same-document-type denial | PASS | Matter A sentinel is absent from Matter B despite identical type and claim. |
| C — Ref/type/claim manipulation | PASS | Matter B cannot select A memory with A labels. |
| D — Case-pattern leakage | PASS | A-derived pattern is absent from B's captured Stage 3 prompt. |
| E — Style-example leakage | PASS | A approved style text is absent from B's captured Stage 4 prompt. |
| F — Firm-safe convention reuse | PASS | Strictly classified generic convention is present for A and B. |
| G — Legacy style/index failure | PASS | Unclassified global style/index remains stored and excluded. |
| H — Legacy pattern failure | PASS | Unclassified global pattern remains stored and excluded. |
| I — Legacy convention failure | PASS | Unclassified global convention remains stored and excluded. |
| J — Invalid-session read | PASS | Unregistered UUID causes no memory read or model call. |
| K — Invalid-session write | PASS | Approval and setup paths write zero protected bytes. |
| L — Cleared session | PASS | Revocation blocks later read/write; durable matter bytes remain inert. |
| M — Forged ref | PASS | A session with B labels still resolves only A. |
| N — Forged browser state | PASS | Browser-supplied identifiers cannot redirect B to A. |
| O — Traversal/prefix collision | PASS | Unsafe IDs and prefix collisions do not produce a protected read. |
| P — Captured Stage 3 isolation | PASS | B has zero A sentinel; A positive control includes it. |
| Q — Captured Stage 4 isolation | PASS | B has zero A sentinel; A positive control includes it. |
| R — Unsafe setup sample | PASS | Raw and derived client sample material stays in A and never becomes global. |
| S — Provenance fields | PASS | New records contain and validate the canonical provenance fields. |
| T — C-1 security regression | PASS | Rebinding is denied and the original immutable root remains valid. |
| U — Same-matter ranking | PASS | Exact type+claim precedes same-type and unrelated records after filtering. |
| V — No automatic promotion | PASS | Matter approval creates no firm-safe artifact. |

## Local verification

The following commands were run from `sln-litigation-drafter` on the exact
pre-commit tree on 4 September 2026:

| Validation | Result |
|---|---|
| C-3 focused suite | PASS — 23/23 (22 canonical fixtures A–V plus one additional citation-memory consumer) |
| C-1 standalone security suites | PASS — 208/208 across three files |
| Full suite | PASS — 978/978 across 61 files |
| `npx tsc --noEmit` | PASS — exit 0 |
| `npm run build` | PASS — Next.js 14.2.35 compiled; 65/65 static pages generated |
| `npm install --legacy-peer-deps` | PASS — up to date; package and lock files unchanged |
| `git diff --check` | PASS — exit 0 (line-ending conversion notices only) |
| Lint | NOT CONFIGURED — EXISTING BASELINE |
| `npm audit` | Recorded without remediation — 9 findings: 1 low, 3 moderate, 5 high |

No audit fix or dependency upgrade was performed.

## Deliberate exclusions

No C-1 architecture change, LDD change, provider/router work, AI-01/02/03,
Hermes, evidence service, vector/RAG platform, dependency upgrade, automatic
sanitization/promotion, Control Tower write, merge or self-approval is included.
