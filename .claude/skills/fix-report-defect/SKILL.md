---
name: fix-report-defect
description: Fix a wrong, missing, or duplicated item in a generated DD or litigation report. Routes the defect to the right layer, reproduces it as a failing test first, then ships it as one branch and one PR.
disable-model-invocation: true
---

# Fix a report defect

The repeating unit of work in this repo. A lawyer reports that a generated
report says something wrong, omits something, or repeats it. Almost every recent
commit is one of these.

The hard part is **not** the fix. It is deciding which layer owns the defect —
they present identically in the output — and writing a test that fails for the
stated reason first, so the same bug cannot return under a new name.

## 1. Get the defect stated in terms of output

Ask for, or establish, all four:

- **What the report says** (quote it) and **what it should say**.
- **Which format**: `pendahuluan_led`, `exec_summary_led`, `findings_only`, or
  `lut_pasar_modal`. Defects are frequently format-specific — a chapter that is
  fine in one format renders empty in another.
- **Which chapter or aspect**, and for transaction chapters, the `clientRole`
  (`pembeli` vs `penjual` plan different chapter kinds).
- **Whether it is wrong or absent.** Wrong content and missing content have
  disjoint causes; do not start looking until you know which.

## 2. Route it to a layer

Check in this order. Stop at the first that explains the symptom.

| Symptom | Layer | Start at |
|---|---|---|
| Chapter renders entirely as *"belum dapat dianalisis"* or a header-only table | **Chapter planning** | `chapterForAspect` in `config/ddChapters.ts` — it matches on `kind`, and a format whose chapters use another kind gets no analysis at all |
| A statute is quoted wrongly, or a provision is invented | **Prompt / boilerplate** | `lib/dd/prompts.ts`, `lib/dd/report-boilerplate.ts` — check the quotation against `data/statutes/` and `config/uuptStructure.ts` |
| A citation check accuses a correct citation, or misses a wrong one | **Verifier** | `lib/dd/statute.ts` (`checkCitations`, `checkUUPTCitations`). Note `foreignHints` deliberately skips non-UUPT instruments |
| A finding exists in the data but never appears, or appears twice | **Renderer** | `findingsForChapter` in `lib/dd/dd-docx-builder.ts` — it matches by aspect set, so two chapters claiming one aspect duplicate every finding |
| Content is silently short or truncated | **Prompt + truncation** | `lib/json-repair.ts` papers over `stop_reason: "max_tokens"`; a truncated response yields a shorter, valid-looking list with no warning |
| Analysis is stale after a prompt or checklist change | **Reuse cache** | `lib/dd/analysis-state.ts` — `promptDigest` keys reuse on what the model was shown |
| Regulation-currency column is blank everywhere | **Config, not code** | `PERPLEXITY_API_KEY` is missing; `checkCurrency` soft-fails to `unknown` by design. Confirm with `lib/dd/health.ts` |

If none fits, read the git log — `git log --oneline -40` — for a commit with the
same shape. This bug class recurs and the earlier fix usually names the layer.

## 3. Reproduce as a failing test, before fixing

Non-negotiable. Add to `tests/dd/` alongside the closest existing file.

Assert on the **content that was wrong**, not on structure. The existing format
tests only check that chapter titles appear, which is exactly why a whole class
of empty-chapter defects ships undetected. If the complaint is "Bab II is
empty", the test asserts the prose is present — not that the heading is.

```bash
cd sln-litigation-drafter
npx vitest related --run lib/dd/<file-you-suspect>.ts
```

Confirm the new test fails **for the reason stated in the defect**, not for a
setup error. Then fix. Then confirm it passes and the suite is still green:

```bash
npm test
```

## 4. Ship it

One defect, one branch, one PR.

```bash
git checkout -b fix/<short-slug>
```

Commit subject describes the behaviour change in plain English, imperative, no
prefix and no scope tag — the way the rest of this repo reads:

> `Correct Pasal 56, misquoted in the capital chapter`
> `Stop cutting an aspect's documents in half without saying so`
> `Stop the citation check accusing correct citations`

The body says what the reader would otherwise have to reconstruct: what the
report did, why, and what the test now pins. Never put client matter names,
document contents, or SharePoint paths in either.

Then open the PR against `main`.

## Do not

- Do not fix it in the renderer because that is where the symptom is visible. A
  wrong quotation fixed in `dd-docx-builder.ts` leaves the prompt still teaching
  the model the wrong provision.
- Do not widen a prompt to paper over a verifier gap, or vice versa.
- Do not change a model ID to make output better. Models come from
  `config/models.ts` and changing a tier is a separate, deliberate decision.
- Do not skip the test because the fix is one line. These specific bugs have
  come back.
