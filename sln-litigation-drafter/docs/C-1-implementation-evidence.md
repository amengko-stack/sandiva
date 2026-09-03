# C-1 implementation evidence — Acceptance Contract v1 / ADR-017

Builder observations for independent semantic security QA. This is not an acceptance decision or merge approval.

## Authority and baseline

- Build: C-1, Litigation Drafter / Specialist Engine Remediation, P0 / CRITICAL.
- Tool/model/effort: Codex / Sol / High.
- Repository: amengko-stack/sandiva.
- Base main: `157a1288c4dda3af497ca2aff5ad95de1e16c569`.
- Branch: `fix/c1-litigation-matter-isolation`.
- Ran fetch, checkout main, pull --ff-only, status and rev-parse. Exact baseline matched; tree was clean before branch creation.
- Read the complete canonical contract and complete ADR-017 entry before production edits.
- Contract SHA-256: `D41088B300ED31337EC34CA748A02D5C5732DB38391B50C41FC17D02E0D40D49`.
- Architecture log SHA-256: `BA3E9FAC12CA73433D0BD0472AA53508025A8E75FE1FA133C459065435029C84`.
- Canonical documents remain in SharePoint, unchanged. No Control Tower writes.

## Current defect trace at the approved baseline

`context/WorkflowContext.tsx` generated IDs in the browser. `lib/blob.ts:isValidSessionId` checked blob-key syntax only. No Litigation root registry or server file manifest existed. LDD's `lib/matter-scope.ts` trusts entity roots selected in Stage 1 and is deliberately a separate model.

Listing and resume trusted folderPath; extraction/add/OCR trusted files[].path. read-files could read existing text on resume and metadata/cache before any matter check; add/OCR read existing artifacts first. analyze-sample read an arbitrary path before model/global memory persistence. DOCX save generated output before checking a matter boundary; generic save restricted filename but not root; inventory read a session report and generated a PDF before a root check.

Baseline red evidence: 12/12 behavioral tests failed across all nine routes and three batch paths. Eight routes returned 200 for an unregistered session; inventory returned its ordinary 404 after accessing the report seam. Mixed batches processed the third cross-matter identity and wrote session blobs. This was observed in `baseline-red.log`, not inferred from source-name matching.

## Server registration and lifecycle

`POST /api/session/register` accepts folderPath and refuses any supplied sessionId. Existing shared-login middleware protects the endpoint. Registration validates the root, resolves a folder (never a file or remote shortcut), issues `crypto.randomUUID()` on the server and performs a create-only private Blob put before returning the identifier. It does not list matter children. Collision/double-submit cannot overwrite another registration. An unsuccessful resolve or put returns no usable ID.

Registry key: `litigation-memory/sessions/<uuid>/litigation-registration.json`.

```json
{"version":1,"status":"active","sessionId":"<server uuid>","root":"<normalized requested root>","driveId":"<resolved drive>","itemId":"<resolved folder>","createdAt":"<ISO timestamp>"}
```

Manifest key: `litigation-memory/sessions/<uuid>/litigation-manifest.json`.

```json
{"version":1,"sessionId":"<same uuid>","root":"<same root>","files":["<server FileEntry records>"]}
```

Only a completed recursive listing of the stored drive/folder replaces the manifest. Ordinary routes never create/rebind registration. Exact drive identity membership is required; path/name/id tampering cannot extend the manifest. Stale snapshots/browser files are not imported into it. New files require refreshing the registered root. Concurrent refreshes can replace a snapshot only with server-listed entries from that same root.

Retention uses the existing whole-session policy: the newest artifact in the session prefix determines expiry (Litigation: 24 hours of inactivity; existing mixed/DD policy unchanged). There is intentionally no independent registry expiry timer that could expire earlier than live work products. Cleanup is the expiry authority: it removes C-1 registration before session artifacts. Missing, malformed and non-active/expired registry state fails closed. Manifest and registry are in the same retention group. No storage migration.

Session clear removes registration first, enumerates all artifact pages and then deletes those artifacts. Failed/partial deletion leaves no usable root authority. A late manifest write cannot recreate registration. Requests already authorized before a clear are not retroactively cancelled; subsequent authorization fails. Other sessions retain their independent records.

## Canonical root and target semantics

- Only exact normalized roots can be listed; recursive listing produces descendant file identities.
- Normalize whitespace around input, URL hostname case, literal/encoded spaces and trailing separators. Preserve path and sharing-token case. Distinct root-reference forms are not guessed equivalent on later requests.
- Reject blank values, dot segments before URL parsing, encoded/double-encoded traversal/separators, malformed escapes, backslashes, fragments, ambiguous Forms/aspx URLs, duplicate internal slashes and unsupported query parameters. Sharing links preserve a single supported `e` token exactly; ordinary path queries are refused.
- Accept folder sharing links, explicit site/library URLs, explicit Site/Shared Documents/folder shorthand and configured-drive relative paths. Registration resolves full URLs by exact site and library; later list/write/resume use the immutable drive location, not the submitted path.
- Recursive Graph listing excludes remote shortcuts and rejects conflicting drive IDs. Pagination may remain only on the same Graph collection.
- Extraction paths must exactly match the current server manifest. Opaque references require exactly three drive: components; site-path references require exact manifest membership and a descendant segment boundary. No substring or filename-only permission.
- Writes preserve the AI/Drafts filename allowlist, reject unsafe targets, and use the registered drive/folder. DOCX save permits Drafts only; inventory generates an AI target.
- External OCR roots are refused. Place OCR output below the registered matter root and refresh that root.

Graph addressing follows [Microsoft's site-by-path API](https://learn.microsoft.com/en-us/graph/api/site-getbypath?view=graph-rest-1.0). Create-only registration uses the installed Blob SDK's `allowOverwrite: false` and `addRandomSuffix: false`, consistent with [Vercel's Blob SDK documentation](https://vercel.com/docs/vercel-blob/using-blob-sdk). No SDK/dependency changes.

## Internal implementation matrix and AC evidence

Every row below is a separate builder-observed PASS. Production seams, adversarial behavior and positive fixtures are identified individually; the full-suite result alone is not the evidence.

| AC | Affected trust boundary | Production seam | Behavioral test | Observed behavior / side-effect proof | Result |
|---|---|---|---|---|---|
| AC-01 — Server-issued session and root registration | Client session creation → server issuance | app/api/session/register/route.ts; lib/litigation-session.ts:createLitigationSession | F01; failed persistence; simultaneous registration | Server UUID and normalized root stored with create-only private put; listing has not run. | PASS |
| AC-02 — Root binding is immutable | Client root request → immutable registration | lib/litigation-session.ts:authorizeLitigation; register route | F02–03; double-submit | Same normalized root lists safely; another root and any sessionId on registration are refused; original bytes remain unchanged. | PASS |
| AC-03 — Missing, expired and legacy state fail closed | Browser/legacy state → active server record | lib/litigation-session.ts:loadRegistration | F04; malformed/expired per-route tables; unknown UUID | All nine routes refuse absent, malformed or expired authority; no work-product or target access. | PASS |
| AC-04 — Registered-root listing only | Requested listing → registered drive folder | app/api/sharepoint/list-files/route.ts; lib/litigation-sharepoint.ts:listMatterFiles | F05–07; path-adversary table | Root equality is checked before recursive Graph listing; sibling, traversal and other host/site/library cause zero calls. | PASS |
| AC-05 — Server-authoritative file manifest | Client file object → server-produced manifest | lib/litigation-session.ts:recordLitigationListing / exactFilePath / authorizeLitigation | F08–09; manifest refresh; exact site-path membership | Only completed server listing writes the manifest; names/IDs/paths cannot grant membership; opaque identities require exact membership. | PASS |
| AC-06 — `read-files` batch authorization is atomic | Selected batch → extraction and session work products | app/api/sharepoint/read-files/route.ts:POST | F10; third-item rejection; F18 read-files | All entries are checked before existing-text read, SSE, metadata, cache, extraction, model or writes. | PASS |
| AC-07 — `add-documents` batch authorization is atomic | Additional batch → prior session text/report | app/api/sharepoint/add-documents/route.ts:POST | F11; third-item rejection; F18 add-documents | Invalid third item prevents all processing; prior bytes unchanged. | PASS |
| AC-08 — OCR recheck remains matter-scoped | OCR selection → single registered matter | app/api/sharepoint/recheck-ocr/route.ts:POST | F12–13; F18 recheck-ocr | Complete manifest check precedes prior text/report and extraction; no external root is registered. | PASS |
| AC-09 — Session resume is bound before work-product access | Browser continuity → SharePoint work products | app/api/sharepoint/check-session/route.ts:POST | F14; F18 check-session; validate resume | Wrong root returns fixed 403 before AI listing/download; stored snapshots never register authority. | PASS |
| AC-10 — Setup sample read is matter-authorized | Setup sample identity → content/model/global memory | app/api/setup/analyze-sample/route.ts:POST | F15; F18 analyze-sample; F20 | Manifest authorization precedes readFileContent, model and existing global style persistence. | PASS |
| AC-11 — Draft SharePoint save is root- and target-scoped | Draft target → matter Drafts folder | app/api/sharepoint-save/route.ts:POST; lib/litigation-paths.ts:requireOutputTarget | F16–17; F18 sharepoint-save | Root and Drafts target validated before DOCX generation, verification or write. | PASS |
| AC-12 — Generic matter-file save preserves and strengthens constraints | Generic output target → matter working folder | app/api/sharepoint/save-matter-file/route.ts:POST | F16–17; F18 save-matter-file | Root binding plus original AI/Drafts filename allowlist; unsafe names refused before write. | PASS |
| AC-13 — Inventory save is authorized before artifact use | Inventory target → report/PDF/write | app/api/docx/inventory-save/route.ts:POST | F16; F18 inventory-save | Root verified before report read/PDF generation; generated target stays under AI/. | PASS |
| AC-14 — Conservative path handling | Ambiguous path spelling → canonical resource identity | lib/litigation-paths.ts; lib/litigation-sharepoint.ts:resolveMatterRoot | F05–07/17; c1-litigation-paths.test.ts | Decode once per segment; reject traversal, encoded separators, malformed escapes, backslashes, ambiguous paths; preserve path/token case. | PASS |
| AC-15 — Authorization precedes every protected side effect | Complete authorization → all protected side effects | All nine POST handlers; authorizeLitigation | F04/10–17; negative route tables | Zero Graph/list/download/upload, cache, normalizer, generation, model and work-product calls on denial; registry/manifest reads alone allowed. | PASS |
| AC-16 — Browser state is not authority | Browser metadata → server-validated continuation | context/WorkflowContext.tsx; app/drafter/page.tsx; app/setup/page.tsx; changed Litigation callers | All route tampering tests; static caller inventory below | Initial/reset IDs empty; registration supplies UUID; hydration validates ID/root; every protected caller sends sessionId. | PASS |
| AC-17 — Current authorized workflow remains functional | Authorized session → existing Litigation workflow | Nine protected routes; necessary client callers | F18 (nine positive paths); full suite | Registered recursive listing, extraction, add, in-root OCR, resume, sample, DOCX, JSON and inventory save all pass. | PASS |
| AC-18 — Scope and architecture boundaries are preserved | C-1 → protected architectural boundaries | Base-to-head production diff; unchanged package manifests | F20; LDD compatibility; separate C2/H1/H3 regressions | No memory destination, analysis/prompt, LDD guard, model, AI-02, dependency, identity or governance changes. | PASS |

## Exact protected-route coverage

All nine require an active server registration; all reject legacy/unregistered state server-side. The authorization point is before the listed external effect, with no work-product read, cache use, extraction, model/generation, mutation or Graph operation before the complete requested batch passes. F18 supplies an authorized positive fixture for each route.

### Protected route 1: `app/api/sharepoint/list-files/route.ts`

- Read/write: Read/list.
- Session required: YES; legacy session rejected: YES.
- Authorization mechanism: `authorizeLitigation` loads active immutable registration and, for source reads, the server manifest.
- Root/path inputs authorized: Exact normalized folderPath; registered driveId/itemId.
- Batch atomicity applicable: NO.
- Authorization point: before listMatterFiles then manifest write.
- Cross-matter fixtures: F04–07, F13.
- In-matter fixture: F18 / list-files.

### Protected route 2: `app/api/sharepoint/read-files/route.ts`

- Read/write: Read/extract.
- Session required: YES; legacy session rejected: YES.
- Authorization mechanism: `authorizeLitigation` loads active immutable registration and, for source reads, the server manifest.
- Root/path inputs authorized: Every files[].path, supplied id/name; optional folderPath.
- Batch atomicity applicable: YES.
- Authorization point: before prior text, metadata/cache/extraction, session writes.
- Cross-matter fixtures: F04, F09–10.
- In-matter fixture: F18 / read-files.

### Protected route 3: `app/api/sharepoint/add-documents/route.ts`

- Read/write: Read/append.
- Session required: YES; legacy session rejected: YES.
- Authorization mechanism: `authorizeLitigation` loads active immutable registration and, for source reads, the server manifest.
- Root/path inputs authorized: Every files[].path, supplied id/name; optional folderPath.
- Batch atomicity applicable: YES.
- Authorization point: before prior text/report, metadata/cache/extraction, append writes.
- Cross-matter fixtures: F04, F09, F11.
- In-matter fixture: F18 / add-documents.

### Protected route 4: `app/api/sharepoint/recheck-ocr/route.ts`

- Read/write: Read/OCR.
- Session required: YES; legacy session rejected: YES.
- Authorization mechanism: `authorizeLitigation` loads active immutable registration and, for source reads, the server manifest.
- Root/path inputs authorized: Every files[].path and supplied name/id.
- Batch atomicity applicable: YES.
- Authorization point: before prior text/report, extraction/cache/session writes.
- Cross-matter fixtures: F04, F12–13.
- In-matter fixture: F18 / recheck-ocr.

### Protected route 5: `app/api/sharepoint/check-session/route.ts`

- Read/write: Read/resume.
- Session required: YES; legacy session rejected: YES.
- Authorization mechanism: `authorizeLitigation` loads active immutable registration and, for source reads, the server manifest.
- Root/path inputs authorized: Exact folderPath; registered root AI/.
- Batch atomicity applicable: NO.
- Authorization point: before listAiFolder, then JSON downloads.
- Cross-matter fixtures: F04, F14.
- In-matter fixture: F18 / check-session.

### Protected route 6: `app/api/setup/analyze-sample/route.ts`

- Read/write: Read/sample.
- Session required: YES; legacy session rejected: YES.
- Authorization mechanism: `authorizeLitigation` loads active immutable registration and, for source reads, the server manifest.
- Root/path inputs authorized: sharePointPath exact manifest member.
- Batch atomicity applicable: NO.
- Authorization point: before readFileContent, existing style persistence, model.
- Cross-matter fixtures: F04, F15.
- In-matter fixture: F18 / analyze-sample.

### Protected route 7: `app/api/sharepoint-save/route.ts`

- Read/write: Write/DOCX.
- Session required: YES; legacy session rejected: YES.
- Authorization mechanism: `authorizeLitigation` loads active immutable registration and, for source reads, the server manifest.
- Root/path inputs authorized: Exact folderPath and safe Drafts/filename.
- Batch atomicity applicable: NO.
- Authorization point: before DOCX generation/verification then drive-root upload.
- Cross-matter fixtures: F04, F16–17.
- In-matter fixture: F18 / sharepoint-save.

### Protected route 8: `app/api/sharepoint/save-matter-file/route.ts`

- Read/write: Write/artifact.
- Session required: YES; legacy session rejected: YES.
- Authorization mechanism: `authorizeLitigation` loads active immutable registration and, for source reads, the server manifest.
- Root/path inputs authorized: Exact folderPath and safe AI/ or Drafts/filename.
- Batch atomicity applicable: NO.
- Authorization point: before drive-root upload.
- Cross-matter fixtures: F04, F16–17.
- In-matter fixture: F18 / save-matter-file.

### Protected route 9: `app/api/docx/inventory-save/route.ts`

- Read/write: Write/inventory.
- Session required: YES; legacy session rejected: YES.
- Authorization mechanism: `authorizeLitigation` loads active immutable registration and, for source reads, the server manifest.
- Root/path inputs authorized: Exact folderPath; server-generated AI/document_inventory_*.pdf.
- Batch atomicity applicable: NO.
- Authorization point: before report read, PDF generation, drive-root upload.
- Cross-matter fixtures: F04, F16.
- In-matter fixture: F18 / inventory-save.

## Browser/server caller inventory

| Caller | Protected calls and session handling |
|---|---|
| context/WorkflowContext.tsx | Empty initial/reset ID; restores browser state only after /api/session/validate validates sessionId + folderPath. |
| app/drafter/page.tsx | check-session sends saved sessionId and folderPath; unknown/expired resume shows refusal guidance. |
| components/stages/Stage2Files.tsx | Registers folder once before initial listing; immediate saves use returned ID; listing, check-session, read-files, OCR listing/recheck, generic saves and inventory saves carry current ID. |
| components/AddDocumentsModal.tsx | Same-root list-files and add-documents, inventory-save and save-matter-file carry current ID; defaults discovery to the registered matter. |
| components/stages/Stage3Analysis.tsx | Every analysis/parties/chronology/interview/assessment SharePoint save carries current ID; model and analysis behavior unchanged. |
| components/ChronologyPanel.tsx; components/ReviewTablePanel.tsx | Their work-product saves carry current ID. |
| components/stages/Stage4Draft.tsx; components/stages/Stage5Output.tsx | Draft save carries current ID; generation/output logic unchanged. Stage 5 clear revokes the current session. |
| app/setup/page.tsx | Registers a selected matter folder, lists its files, selects a server-listed sample identity, sends sessionId to analyze-sample. New matter selection starts a distinct session. Existing global memory persistence unchanged. |
| components/dd/DDStage1Setup.tsx; components/dd/DDStage2Extract.tsx | URL-only move to /api/dd/list-files preserves the baseline LDD listing request and response. No Litigation session model imposed on LDD. |

UI payload evidence is exact caller inventory/static review plus TypeScript/build, as allowed by AC-16. No browser end-to-end or live client-document exercise is claimed. Route behavior tests enforce authority independently of UI correctness.

The LDD compatibility endpoint preserves the previous shared listing implementation. This is necessary because adding C-1 to the shared route otherwise breaks the existing LDD Stage-1 and OCR-folder discovery callers. LDD remains governed by its existing separate transaction/entity-root architecture. This is not a per-user ethical-wall restriction or a claim that other specialist workflows adopt C-1.

## Session security matrix

| Property | Observed result |
|---|---|
| Session generated by server | YES |
| Client-generated arbitrary ID usable | NO |
| Exactly one root per session | YES |
| Root immutable after binding | YES |
| Unknown session | FAIL CLOSED |
| Legacy session | FAIL CLOSED |
| Root mismatch | FAIL CLOSED |
| Session clear invalidates authority | YES |
| Browser state treated as authority | NO |

## Canonical required fixtures

The names below are copied from section 9 of the unchanged v1 contract. Fxx identifies the corresponding numbered production-route fixture/group in `tests/c1-litigation-routes.test.ts`; path adversaries and real Graph request construction are additionally covered by `tests/c1-litigation-paths.test.ts`.

1. **PASS — Server registration returns a valid server-issued Litigation session and stores one root.**
2. **PASS — Same-root repeat is safe/idempotent.**
3. **PASS — Different-root rebind fails.**
4. **PASS — Missing/legacy registry fails before target access.**
5. **PASS — Root `Alpha` does not authorize sibling `Alpha-Holdings`.**
6. **PASS — Traversal and encoded traversal fail.**
7. **PASS — Listing a different host/site/library fails before Graph listing.**
8. **PASS — Server listing populates exact allowed file identities.**
9. **PASS — Forged `FileEntry.id`, name or path does not enter the manifest.**
10. **PASS — `read-files` mixed authorized/unauthorized batch is rejected atomically with zero downstream calls.**
11. **PASS — `add-documents` mixed batch is rejected atomically and preserves prior session bytes.**
12. **PASS — OCR mixed batch is rejected atomically.**
13. **PASS — External OCR folder is rejected under the single-root rule.**
14. **PASS — `check-session` wrong root performs zero AI-folder listings/downloads.**
15. **PASS — Unauthorized setup sample performs zero file-read, model or memory-write calls.**
16. **PASS — Each of the three write routes rejects a wrong root with zero write-side effects.**
17. **PASS — Unsafe `Drafts/../` and `AI/../` targets fail.**
18. **PASS — All nine routes succeed on their authorized positive path.**
19. **PASS — Registration/manifest retention expires with the session, not earlier or independently.**
20. **PASS — C-3 global-memory behavior is unchanged and remains explicitly open.**

## Deterministic verification

All commands ran from sln-litigation-drafter, using Windows .cmd shims or the direct Node Vitest entry point. The first sandboxed Vitest attempt hit spawn EPERM; the authorized execution path then reproduced the baseline failures. This environment error was not treated as an application result.

| Check / exact command | Observed result |
|---|---|
| npm.cmd install --legacy-peer-deps | Exit 0; up to date, 389 packages audited; dependency file hashes unchanged. |
| npm.cmd test -- tests/c1-litigation-routes.test.ts tests/c1-litigation-paths.test.ts | 2 files / 120 tests passed. |
| npm.cmd test -- tests/c1-litigation-routes.test.ts | 1 file / 95 tests passed; all nine protected routes. |
| npm.cmd test -- tests/sharepoint.test.ts | 1 file / 7 existing SharePoint tests passed. |
| node node_modules/vitest/vitest.mjs run tests/c1-litigation-routes.test.ts -t 'registration\|registry\|resume\|clear\|cleanup\|retention\|rebind\|Same-root\|validate' | 38 selected tests passed; 57 nonmatching tests filtered out, all of which passed in the unfiltered run. Actual regex uses unescaped vertical bars. |
| node node_modules/vitest/vitest.mjs run tests/document-normalizer.test.ts | 1 file / 7 tests passed. |
| node node_modules/vitest/vitest.mjs run tests/dd/matter-scope.test.ts tests/dd/recheck-ocr-matter-scope.test.ts | 2 files / 21 tests passed. |
| node node_modules/vitest/vitest.mjs run tests/dd/raw-evidence-preservation.test.ts tests/dd/raw-evidence-route.test.ts | 2 files / 10 C-2 tests passed. |
| node node_modules/vitest/vitest.mjs run tests/dd/h1-verifier-source-integrity.test.ts | 1 file / 19 H-1 tests passed. |
| node node_modules/vitest/vitest.mjs run tests/dd/h3-analysis-cache-correctness.test.ts tests/dd/analysis-state.test.ts | 2 files / 35 H-3/state tests passed. |
| node node_modules/vitest/vitest.mjs run tests/dd/retention.test.ts | 1 file / 16 retention tests passed. |
| npm.cmd test | 59 files / 867 tests passed; zero skipped. |
| npx.cmd tsc --noEmit | Exit 0. |
| npm.cmd run build | Exit 0; 65/65 pages generated. |
| git diff --check | Exit 0. |
| Lint | NOT CONFIGURED — EXISTING BASELINE. CI explicitly documents absent ESLint dependency/config; the next lint script is not counted as a passing gate. |
| npm.cmd audit --json | Exit 1: 9 existing vulnerabilities (1 low, 3 moderate, 5 high, 0 critical); no fixes/upgrades applied. |
| GitHub Actions / Vercel | Record exact final-head results in the draft-PR handoff; local build is not a substitute. |

Audit packages: @xmldom/xmldom (moderate), brace-expansion (high), exceljs (moderate), nanoid (high), next (high), postcss (high), postcss-selector-parser (low), undici (high), uuid (moderate).

Unchanged package.json SHA-256: `F92E9272A469F9B1798BD427963E45A66C816F7409989AE7F5D3F156E7D5379D`.
Unchanged package-lock.json SHA-256: `EF8AE73926A502229488686F4A79DB86DEFD2A613A0CB2213B76E02CB661B2A1`.

## Semantic diff and scope review

Production changes are the Litigation-specific registration/authorization/Graph helpers, nine guarded routes, narrow cleanup ordering/pagination, registration/validation endpoints and necessary client callers. The shared sharepoint helper only exports its existing token function. LDD's two caller URLs move to a behavior-preserving compatibility listing endpoint; no LDD guard or analysis logic changes.

C-3 global-memory destinations, firm conventions, style_examples and case_patterns semantics remain unchanged and open. No C-2, H-1, H-2, H-3, model prompt, report, AI-02/Azure Stage 1, AI-01, AI-03, Hermes, Graph permission, dependency or Control Tower change. No architecture change beyond ADR-017 and no specification change. Every production diff was reviewed before draft-PR creation.

## Residual risks / explicit non-claims

This build is ready only for independent semantic security QA after the recorded deterministic gates. It is not self-approved, accepted, merged or activated by this report. Existing shared-login users can register a fresh session for a matter reachable by the application's credential: H-11 per-user authorization remains separate. The broad Graph application permission is unchanged. C-3 global style/pattern memory and H-6 citation verification remain open. Existing dependency vulnerabilities remain. Root aliases fail closed rather than being re-resolved on protected requests. External OCR folders require moving output under the matter or a separate future architectural decision. Retention expiry occurs through the existing cleanup lifecycle, not an independent authorization timer. No live client documents were accessed for validation.

## Complete changed-file inventory

- `app/api/dd/list-files/route.ts`
- `app/api/session/register/route.ts`
- `app/api/session/validate/route.ts`
- `docs/C-1-implementation-evidence.md`
- `lib/litigation-paths.ts`
- `lib/litigation-session.ts`
- `lib/litigation-sharepoint.ts`
- `sln-litigation-drafter/app/api/cron/cleanup-sessions/route.ts`
- `sln-litigation-drafter/app/api/docx/inventory-save/route.ts`
- `sln-litigation-drafter/app/api/session/clear/route.ts`
- `sln-litigation-drafter/app/api/setup/analyze-sample/route.ts`
- `sln-litigation-drafter/app/api/sharepoint-save/route.ts`
- `sln-litigation-drafter/app/api/sharepoint/add-documents/route.ts`
- `sln-litigation-drafter/app/api/sharepoint/check-session/route.ts`
- `sln-litigation-drafter/app/api/sharepoint/list-files/route.ts`
- `sln-litigation-drafter/app/api/sharepoint/read-files/route.ts`
- `sln-litigation-drafter/app/api/sharepoint/recheck-ocr/route.ts`
- `sln-litigation-drafter/app/api/sharepoint/save-matter-file/route.ts`
- `sln-litigation-drafter/app/drafter/page.tsx`
- `sln-litigation-drafter/app/setup/page.tsx`
- `sln-litigation-drafter/components/AddDocumentsModal.tsx`
- `sln-litigation-drafter/components/ChronologyPanel.tsx`
- `sln-litigation-drafter/components/ReviewTablePanel.tsx`
- `sln-litigation-drafter/components/dd/DDStage1Setup.tsx`
- `sln-litigation-drafter/components/dd/DDStage2Extract.tsx`
- `sln-litigation-drafter/components/stages/Stage2Files.tsx`
- `sln-litigation-drafter/components/stages/Stage3Analysis.tsx`
- `sln-litigation-drafter/components/stages/Stage4Draft.tsx`
- `sln-litigation-drafter/components/stages/Stage5Output.tsx`
- `sln-litigation-drafter/context/WorkflowContext.tsx`
- `sln-litigation-drafter/lib/sharepoint.ts`
- `tests/c1-litigation-paths.test.ts`
- `tests/c1-litigation-routes.test.ts`
