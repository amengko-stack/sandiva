import { describe, it, expect } from "vitest";
import {
  EMPTY_ANALYSIS_STATE, aspectDocsDigest, canReuseAspect, parseAnalysisState, promptDigest,
  seenDigest,
} from "@/lib/dd/analysis-state";
import type { DDAnalysisState } from "@/lib/dd/analysis-state";
import type { DDClassifiedDoc } from "@/types/dd";

// Measured, not assumed: two consecutive Stage 5 runs over an unchanged data room
// kept only 7 of 33 model finding ids — 21%. The model re-quotes a different passage
// and rewords the problem, so any identity derived from its output moves. That lost
// the lawyer's review on four findings in five and made the supplement report 33
// issues as "no longer raised" when nothing had gone. Keying on aspect+file matched
// 76% but collided 15 times in one run; a similarity matcher reached 52% recall at
// unknown precision, and a dismissal landing on the wrong finding is worse than one
// lost. So findings are not re-derived when nothing has changed for them.

const doc = (fileName: string, aspectId: string): DDClassifiedDoc =>
  ({ fileName, aspectId, confidence: 1, reason: "" }) as unknown as DDClassifiedDoc;

const CLASSIFIED = [
  doc("akta16.pdf", "pendirian_ad"),
  doc("akta17.pdf", "pendirian_ad"),
  doc("nib.pdf", "perizinan"),
];
const TEXT = new Map<string, string>([
  ["akta16.pdf", "isi akta 16"],
  ["akta17.pdf", "isi akta 17"],
  ["nib.pdf", "isi nib"],
]);

describe("aspectDocsDigest", () => {
  it("is stable for the same documents and the same text", () => {
    expect(aspectDocsDigest("pendirian_ad", CLASSIFIED, TEXT)).toBe(
      aspectDocsDigest("pendirian_ad", CLASSIFIED, TEXT)
    );
  });

  it("ignores the order the documents happen to be listed in", () => {
    const shuffled = [CLASSIFIED[1], CLASSIFIED[2], CLASSIFIED[0]];
    expect(aspectDocsDigest("pendirian_ad", shuffled, TEXT)).toBe(
      aspectDocsDigest("pendirian_ad", CLASSIFIED, TEXT)
    );
  });

  it("changes when a document is added to the aspect", () => {
    const more = CLASSIFIED.concat(doc("akta18.pdf", "pendirian_ad"));
    const text = new Map(TEXT).set("akta18.pdf", "isi akta 18");
    expect(aspectDocsDigest("pendirian_ad", more, text)).not.toBe(
      aspectDocsDigest("pendirian_ad", CLASSIFIED, TEXT)
    );
  });

  // A replaced document keeps its name; a re-OCR changes the text under an
  // unchanged name. Either changes what the aspect is shown.
  it("changes when a document's text changes under the same name", () => {
    const rescanned = new Map(TEXT).set("akta16.pdf", "isi akta 16, hasil pindai ulang");
    expect(aspectDocsDigest("pendirian_ad", CLASSIFIED, rescanned)).not.toBe(
      aspectDocsDigest("pendirian_ad", CLASSIFIED, TEXT)
    );
  });

  it("is unaffected by a change to another aspect's documents", () => {
    const other = new Map(TEXT).set("nib.pdf", "nib yang diperbarui");
    expect(aspectDocsDigest("pendirian_ad", CLASSIFIED, other)).toBe(
      aspectDocsDigest("pendirian_ad", CLASSIFIED, TEXT)
    );
    expect(aspectDocsDigest("perizinan", CLASSIFIED, other)).not.toBe(
      aspectDocsDigest("perizinan", CLASSIFIED, TEXT)
    );
  });
});

describe("canReuseAspect", () => {
  const digest = aspectDocsDigest("pendirian_ad", CLASSIFIED, TEXT);
  const PROMPT = promptDigest("instruksi versi A");
  const prior: DDAnalysisState = {
    aspects: {
      pendirian_ad: { docsDigest: digest, promptDigest: PROMPT, analysedAtISO: "2026-08-01T00:00:00.000Z" },
    },
  };

  it("reuses an aspect whose documents and findings are both intact", () => {
    expect(canReuseAspect({ aspectId: "pendirian_ad", docsDigest: digest, promptDigest: PROMPT, prior, priorFindingCount: 8 })).toBe(true);
  });

  it("re-analyses when the documents have changed", () => {
    expect(canReuseAspect({ aspectId: "pendirian_ad", docsDigest: "lain", promptDigest: PROMPT, prior, priorFindingCount: 8 })).toBe(false);
  });

  it("re-analyses an aspect that was never analysed before", () => {
    expect(canReuseAspect({ aspectId: "perizinan", docsDigest: digest, promptDigest: PROMPT, prior, priorFindingCount: 8 })).toBe(false);
  });

  // Skipping an aspect with nothing to carry would drop it from the report
  // silently, which is worse than paying for the analysis again.
  it("re-analyses when there are no prior findings to carry", () => {
    expect(canReuseAspect({ aspectId: "pendirian_ad", docsDigest: digest, promptDigest: PROMPT, prior, priorFindingCount: 0 })).toBe(false);
  });
});

describe("parseAnalysisState", () => {
  it("reads a stored state", () => {
    const state: DDAnalysisState = {
      aspects: { perizinan: { docsDigest: "abc", analysedAtISO: "2026-08-01T00:00:00.000Z" } },
    };
    expect(parseAnalysisState(JSON.stringify(state))).toEqual(state);
  });

  // The failure must always be "analyse everything", never "skip everything":
  // skipping on a corrupt file would silently freeze the findings forever.
  it("falls back to analysing everything on missing or corrupt state", () => {
    expect(parseAnalysisState(null)).toEqual(EMPTY_ANALYSIS_STATE);
    expect(parseAnalysisState("{bukan json")).toEqual(EMPTY_ANALYSIS_STATE);
    expect(parseAnalysisState("[]")).toEqual(EMPTY_ANALYSIS_STATE);
    expect(parseAnalysisState("null")).toEqual(EMPTY_ANALYSIS_STATE);
  });
});

// Five misstatements of UUPT were corrected in the prompt after reading a live
// report, and none of those corrections would have reached an existing matter: reuse
// turned only on the documents, which had not changed. An improvement nobody
// receives is indistinguishable from no improvement.
describe("a change of instructions invalidates the analysis", () => {
  const digest = aspectDocsDigest("pendirian_ad", CLASSIFIED, TEXT);
  const before = promptDigest("instruksi versi A");
  const after = promptDigest("instruksi versi A, ditambah koreksi Pasal 142");
  const prior: DDAnalysisState = {
    aspects: {
      pendirian_ad: { docsDigest: digest, promptDigest: before, analysedAtISO: "2026-08-01T00:00:00.000Z" },
    },
  };

  it("re-analyses when the prompt changed, even though the documents did not", () => {
    expect(canReuseAspect({ aspectId: "pendirian_ad", docsDigest: digest, promptDigest: after, prior, priorFindingCount: 8 })).toBe(false);
  });

  it("still reuses when neither changed", () => {
    expect(canReuseAspect({ aspectId: "pendirian_ad", docsDigest: digest, promptDigest: before, prior, priorFindingCount: 8 })).toBe(true);
  });

  // A hand-maintained version number is forgotten exactly when it matters: the run
  // after a fix. Hashing the prompt itself cannot be forgotten.
  it("derives the digest from the prompt text, so any edit changes it", () => {
    expect(promptDigest("a")).not.toBe(promptDigest("a "));
    expect(promptDigest("a")).toBe(promptDigest("a"));
  });

  // A state written before this field existed must re-analyse once rather than
  // silently serve an answer produced under unknown instructions.
  it("re-analyses a record written before prompts were tracked", () => {
    const old: DDAnalysisState = {
      aspects: { pendirian_ad: { docsDigest: digest, analysedAtISO: "2026-08-01T00:00:00.000Z" } },
    };
    expect(canReuseAspect({ aspectId: "pendirian_ad", docsDigest: digest, promptDigest: after, prior: old, priorFindingCount: 8 })).toBe(false);
  });
});

// Reuse must turn on what the model was shown, not on what the data room holds.
// When whole-document packing replaced a mid-stream cut, the corpus was byte for
// byte identical, so every existing matter would have gone on serving analysis
// written from a truncated view of its own documents.
describe("seenDigest", () => {
  it("changes when the selected text changes", () => {
    expect(seenDigest("a", [])).not.toBe(seenDigest("ab", []));
  });

  it("changes when a document is omitted that was not omitted before", () => {
    expect(seenDigest("a", [])).not.toBe(seenDigest("a", ["besar.pdf"]));
  });

  it("is stable for the same view", () => {
    expect(seenDigest("a", ["x.pdf"])).toBe(seenDigest("a", ["x.pdf"]));
  });

  // The separator matters: without it, text ending in a name and an empty omission
  // list would collide with shorter text and that name omitted.
  it("does not collide across the text and omission boundary", () => {
    expect(seenDigest("ax.pdf", [])).not.toBe(seenDigest("a", ["x.pdf"]));
  });
});
