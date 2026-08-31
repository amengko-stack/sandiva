# sandiva-dd

Two separate apps live in this repo. Read this before running anything — the
working directory is the most common source of wasted time here.

| Directory | App | Status |
|---|---|---|
| [`sln-litigation-drafter/`](sln-litigation-drafter/) | Next.js 14 App Router — litigation drafting + legal due diligence (LDD) | **Active.** Almost all work happens here. |
| `client/` + `server/` + `shared/` | Vite + React 18 + Express 5 + Drizzle/Supabase | Legacy. Do not change unless asked. |

## Running things

Every command below runs from `sln-litigation-drafter/`, not the repo root.

```bash
cd sln-litigation-drafter
npm install --legacy-peer-deps   # plain `npm install` fails; see vercel.json
npm run dev
npm test                          # vitest run — 42 files, ~541 tests, ~2.5s
npx vitest related --run lib/dd/statute.ts   # only the tests covering one file
npx tsc --noEmit                  # the only static gate — see "Known broken"
```

The repo root has **no `test` script**. `npm test` there fails.

## Known broken / absent

- `npm run lint` does nothing useful — there is no ESLint config and `eslint` is
  not a dependency. `next build` skips linting too. `tsc --noEmit` is the only
  static check.
- There is **no CI**. No `.github/` workflow runs those 541 tests. If you change
  anything under `lib/dd/`, run the tests yourself before opening a PR.

## Anthropic model selection

Every Anthropic call picks its model from [`config/models.ts`](sln-litigation-drafter/config/models.ts) —
a central tier map keyed by pipeline stage. **Never inline a model ID at a call
site.** Change the tier in that file instead.

Note the IDs there are Claude 4.x (`claude-sonnet-4-6`, `claude-opus-4-8`). The
current generation is the Claude 5 family. Load the `claude-api` skill before
changing any of them — it carries current IDs, pricing and migration notes.

## Due diligence (LDD) architecture

Six stages: select → extract → classify → tables → review → export. UI in
[`components/dd/`](sln-litigation-drafter/components/dd/), routes in
[`app/api/dd/`](sln-litigation-drafter/app/api/dd/), logic in
[`lib/dd/`](sln-litigation-drafter/lib/dd/).

When a generated report is wrong, the fix lands in one of four layers. Identify
which before editing — they fail in ways that look alike from the output:

| Layer | Files | Owns |
|---|---|---|
| **Prompt** | `lib/dd/prompts.ts`, `lib/dd/redflag.ts`, `lib/dd/narrative.ts` | What the model is told and shown |
| **Verifier** | `lib/dd/verify.ts`, `lib/dd/grounding.ts`, `lib/dd/statute.ts`, `lib/dd/currency.ts` | Catching a wrong model answer after the fact |
| **Chapter planning** | `config/ddChapters.ts`, `lib/dd/report-chapters.ts`, `lib/dd/regime.ts` | Which chapters exist and which aspect feeds each |
| **Renderer** | `lib/dd/dd-docx-builder.ts`, `dd-excel-builder.ts`, `report-boilerplate.ts` | Turning findings into a Word/Excel file |

A wrong statute quotation is usually **prompt or boilerplate**. A chapter that
renders empty is almost always **chapter planning** — `chapterForAspect` matching
on `kind`. A finding that exists but never appears is the **renderer**.

Statute text lives in [`data/statutes/`](sln-litigation-drafter/data/statutes/);
the parsed UUPT map is committed at `config/uuptStructure.ts`.

## Conventions

- **One fix per branch.** `fix/<slug>`, `feat/<slug>`, `chore/<slug>` → PR → merge.
- **Commit subjects describe the behaviour change in plain English**, imperative
  mood, no conventional-commits prefix and no scope tag. They read like the
  changelog entry a lawyer would understand:

  > `Stop reporting a supplied-but-unreadable document as not supplied`
  > `Tell the model Pasal 93 and 110 ayat (1) stop at huruf c`
  > `Correct Pasal 56, misquoted in the capital chapter`

  Not `fix(dd): citation bug`.
- **Test first.** The bug classes here recur; a test that fails for the stated
  reason before the fix is what stops them coming back. Existing tests in
  `tests/dd/` show the house style.
- Comments explain *why*, often at length, and record what a past failure cost.
  See [`vitest.config.ts`](sln-litigation-drafter/vitest.config.ts) for the tone.
  Match it — do not strip these when editing nearby code.

## Confidentiality

This app handles privileged client documents. Never paste document contents,
matter names, or SharePoint paths into commit messages, test fixtures, or issue
text. Fixtures use invented entities (`PT Alpha`).
