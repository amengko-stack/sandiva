import type { DDFinding } from "@/types/dd";

/**
 * Carry the lawyer's review across a re-run of the analysis.
 *
 * Stage 5 writes findings.json. The review UI reads it, the lawyer dismisses what
 * is not a real issue and rewords what is, and writes the array back to the same
 * key. Re-running Stage 5 then overwrote the file, so every dismissal and every
 * rewording was lost — on precisely the run that matters, the one that takes in
 * the documents that arrived after the interim report.
 *
 * Only the lawyer's own decisions are carried: the review status and the replacement
 * wording. Everything the pipeline derives — severity, the legal consequence, the
 * regulation references, the grounding verdict — comes fresh, because a re-run
 * exists to reconsider those against a larger document set. Carrying a stale
 * grounding verdict would be the worse bug: it would report a quote as verified
 * against a document that has since changed.
 *
 * A finding absent from the new run is dropped rather than kept. If the analysis no
 * longer raises it, presenting it because it was raised before would be reporting a
 * conclusion the current examination does not support. The count is returned so the
 * caller can say how many dismissals went with it.
 */

export interface CarryReviewResult {
  findings: DDFinding[];
  /** Findings whose review state was carried over from the previous run. */
  carried: number;
  /** Previously reviewed findings the new run no longer raises. */
  dropped: number;
}

/** The lawyer's replacement wording, or "" when there is nothing usable. */
function usableEdit(f: DDFinding): string {
  return (f.editedProblem ?? "").trim();
}

/** Review decisions worth carrying; "open" is the absence of a decision. */
function hasDecision(f: DDFinding): boolean {
  return f.status !== "open" || usableEdit(f) !== "";
}

export function carryReviewState(
  fresh: DDFinding[],
  previous: DDFinding[]
): CarryReviewResult {
  const decided = new Map<string, DDFinding>();
  for (let i = 0; i < previous.length; i++) {
    if (hasDecision(previous[i])) decided.set(previous[i].id, previous[i]);
  }
  if (decided.size === 0) return { findings: fresh, carried: 0, dropped: 0 };

  let carried = 0;
  const matched = new Set<string>();
  const findings = fresh.map((f) => {
    const prior = decided.get(f.id);
    if (prior === undefined) return f;
    matched.add(f.id);
    carried++;
    // A blank edit is not an edit. Renderers select the problem text with
    // `editedProblem ?? problem`, and "" is not nullish — carrying an empty string
    // would blank the finding's problem column in the client report while leaving
    // the row, its risk level and its recommendation in place. An empty edit
    // therefore leaves the fresh wording and does not claim the status "edited".
    const edit = usableEdit(prior);
    if (edit === "") {
      return {
        ...f,
        status: prior.status === "edited" ? f.status : prior.status,
        editedProblem: undefined,
      };
    }
    return { ...f, status: prior.status, editedProblem: edit };
  });

  let dropped = 0;
  decided.forEach((_, id) => {
    if (!matched.has(id)) dropped++;
  });

  return { findings, carried, dropped };
}
