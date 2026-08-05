import { describe, it, expect } from "vitest";
import { assignModelFindingIds, modelFindingId } from "@/lib/dd/finding-identity";
import { carryReviewState } from "@/lib/dd/review-state";
import { parseRedFlagResponse } from "@/lib/dd/redflag";
import type { DDFinding } from "@/types/dd";

// Findings used to be identified by their position in the model's output:
// `${entityId}-risiko-${aspectId}-${n}`. Stage 5 gets re-run — that is the whole
// point of the interim-then-final workflow — and the review endpoint writes the
// lawyer's dismissals and rewordings back to the same key that Stage 5 overwrites.
// So a re-run discarded the entire review, and any attempt to merge the two by id
// would have been worse: position 2 of the second run is a different finding from
// position 2 of the first, so "dismissed" would land on an issue nobody had read.

const finding = (over: Partial<DDFinding> = {}): DDFinding => ({
  id: "x", entityId: "e1", aspectId: "perizinan", dimension: "risiko",
  severity: "material", anchor: "izin berlaku sampai 12 Mei 2024",
  sourceFile: "nib.pdf", problem: "Izin kedaluwarsa", whyItMatters: "Operasi tanpa izin",
  suggestedFix: "Perpanjang", verified: false, status: "open",
  ...over,
});

describe("modelFindingId", () => {
  const base = {
    entityId: "e1", aspectId: "perizinan" as const,
    sourceFile: "nib.pdf", anchor: "izin berlaku sampai 12 Mei 2024", problem: "Izin kedaluwarsa",
  };

  it("is the same id for the same issue found again", () => {
    expect(modelFindingId(base)).toBe(modelFindingId({ ...base }));
  });

  // The point of the change: order must not enter the identity.
  it("does not depend on the finding's position", () => {
    const [a, b] = assignModelFindingIds([base, { ...base, anchor: "lain sama sekali berbeda" }]);
    const [b2, a2] = assignModelFindingIds([{ ...base, anchor: "lain sama sekali berbeda" }, base]);
    expect(a).toBe(a2);
    expect(b).toBe(b2);
  });

  // Severity and prose move between runs for what is plainly the same issue, so
  // they must not be part of what makes two findings the same finding.
  it("survives reworded prose and a changed severity", () => {
    expect(modelFindingId({ ...base, problem: "Perizinan telah habis masa berlakunya" }))
      .toBe(modelFindingId(base));
  });

  it("distinguishes different documents and different aspects", () => {
    expect(modelFindingId({ ...base, sourceFile: "izin-lain.pdf" })).not.toBe(modelFindingId(base));
    expect(modelFindingId({ ...base, aspectId: "perpajakan" })).not.toBe(modelFindingId(base));
  });

  it("falls back to the problem text when a finding has no quote", () => {
    const noQuote = { ...base, anchor: "" };
    expect(modelFindingId(noQuote)).toBe(modelFindingId({ ...noQuote }));
    expect(modelFindingId(noQuote)).not.toBe(modelFindingId(base));
  });

  it("carries the aspect in the id so it stays readable in logs", () => {
    expect(modelFindingId(base)).toContain("e1-risiko-perizinan-");
  });

  // A deed can be both unregistered and unpublished: two findings, one passage.
  it("keeps two distinct findings on the same passage apart", () => {
    const ids = assignModelFindingIds([base, base]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("parseRedFlagResponse assigns content ids", () => {
  const raw = (anchor: string) =>
    JSON.stringify({
      findings: [
        { severity: "kritis", anchor, sourceFile: "nib.pdf", problem: "p", whyItMatters: "w", suggestedFix: "s" },
      ],
    });

  it("gives the same finding the same id across two runs", () => {
    const a = parseRedFlagResponse(raw("izin berlaku sampai 12 Mei 2024"), null, {
      entityId: "e1", aspectId: "perizinan",
    }).findings[0];
    const b = parseRedFlagResponse(raw("izin berlaku sampai 12 Mei 2024"), null, {
      entityId: "e1", aspectId: "perizinan",
    }).findings[0];
    expect(a.id).toBe(b.id);
    expect(a.id).not.toMatch(/-0$/); // no longer positional
  });

  it("gives different findings different ids", () => {
    const two = parseRedFlagResponse(
      JSON.stringify({
        findings: [
          { severity: "kritis", anchor: "izin berlaku sampai 12 Mei 2024", sourceFile: "nib.pdf", problem: "a", whyItMatters: "w", suggestedFix: "s" },
          { severity: "minor", anchor: "modal disetor 27,5 persen dari modal dasar", sourceFile: "akta.pdf", problem: "b", whyItMatters: "w", suggestedFix: "s" },
        ],
      }),
      null,
      { entityId: "e1", aspectId: "perizinan" }
    ).findings;
    expect(two[0].id).not.toBe(two[1].id);
  });
});

describe("carryReviewState", () => {
  it("keeps a dismissal across a re-run", () => {
    const prev = [finding({ id: "a", status: "dismissed" })];
    const fresh = [finding({ id: "a" }), finding({ id: "b" })];
    const out = carryReviewState(fresh, prev);
    expect(out.findings.find((f) => f.id === "a")?.status).toBe("dismissed");
    expect(out.findings.find((f) => f.id === "b")?.status).toBe("open");
    expect(out.carried).toBe(1);
  });

  it("keeps the lawyer's replacement wording", () => {
    const prev = [finding({ id: "a", status: "edited", editedProblem: "Redaksi pengacara" })];
    const out = carryReviewState([finding({ id: "a", problem: "Redaksi model" })], prev);
    expect(out.findings[0].editedProblem).toBe("Redaksi pengacara");
    expect(out.findings[0].problem).toBe("Redaksi model");
  });

  // A re-run exists to reconsider the pipeline's own conclusions against a larger
  // document set. Carrying a stale grounding verdict would be the worse bug: it
  // would report a quote as verified against a document that has since changed.
  it("does not carry anything the pipeline derives", () => {
    const prev = [
      finding({
        id: "a", severity: "kritis", status: "dismissed",
        grounding: { verdict: "verified", coverage: 1, note: "lama" },
        legalConsequence: "lama", currencyStatus: "current",
      }),
    ];
    const fresh = [
      finding({
        id: "a", severity: "minor",
        grounding: { verdict: "not_found", coverage: 0.1, note: "baru" },
        legalConsequence: "baru",
      }),
    ];
    const out = carryReviewState(fresh, prev);
    expect(out.findings[0].status).toBe("dismissed");
    expect(out.findings[0].severity).toBe("minor");
    expect(out.findings[0].grounding?.verdict).toBe("not_found");
    expect(out.findings[0].legalConsequence).toBe("baru");
    expect(out.findings[0].currencyStatus).toBeUndefined();
  });

  it("counts a reviewed finding the new run no longer raises", () => {
    const out = carryReviewState([finding({ id: "b" })], [finding({ id: "a", status: "dismissed" })]);
    expect(out.dropped).toBe(1);
    expect(out.carried).toBe(0);
    // Not resurrected: presenting it would report a conclusion this examination
    // does not support.
    expect(out.findings.map((f) => f.id)).toEqual(["b"]);
  });

  it("ignores findings the lawyer never decided on", () => {
    const out = carryReviewState([finding({ id: "a" })], [finding({ id: "a", status: "open" })]);
    expect(out.carried).toBe(0);
    expect(out.dropped).toBe(0);
  });

  it("returns the fresh findings untouched when there is no previous run", () => {
    const fresh = [finding({ id: "a" })];
    expect(carryReviewState(fresh, []).findings).toBe(fresh);
  });

  it("is idempotent, since persist() runs at every checkpoint", () => {
    const prev = [finding({ id: "a", status: "dismissed" })];
    const once = carryReviewState([finding({ id: "a" })], prev);
    const twice = carryReviewState(once.findings, prev);
    expect(twice.findings[0].status).toBe("dismissed");
    expect(twice.carried).toBe(1);
  });
});

describe("defects Codex found", () => {
  // Renderers select the problem text with `editedProblem ?? problem`, and "" is not
  // nullish. Carrying a blank edit would blank the problem column in the client
  // report while leaving the row, its risk level and its recommendation in place.
  it("does not carry a blank edit over the fresh problem text", () => {
    for (const blank of ["", "   ", "\n"]) {
      const prev = [finding({ id: "a", status: "edited", editedProblem: blank })];
      const out = carryReviewState([finding({ id: "a", problem: "redaksi model" })], prev);
      expect(out.findings[0].editedProblem, JSON.stringify(blank)).toBeUndefined();
      expect(out.findings[0].problem).toBe("redaksi model");
      // Nor does it claim the status "edited" when nothing was written.
      expect(out.findings[0].status).toBe("open");
    }
  });

  it("still carries a dismissal that happens to have a blank edit", () => {
    const prev = [finding({ id: "a", status: "dismissed", editedProblem: "  " })];
    const out = carryReviewState([finding({ id: "a" })], prev);
    expect(out.findings[0].status).toBe("dismissed");
    expect(out.findings[0].editedProblem).toBeUndefined();
  });

  it("trims a real edit rather than storing the padding", () => {
    const prev = [finding({ id: "a", status: "edited", editedProblem: "  redaksi pengacara  " })];
    const out = carryReviewState([finding({ id: "a" })], prev);
    expect(out.findings[0].editedProblem).toBe("redaksi pengacara");
  });
});

// Two findings can quote one passage — a deed both unregistered and unpublished.
// Distinguishing them by arrival order let a dismissal migrate to the other issue
// the moment the model emitted them the other way round: a review decision landing
// on an issue nobody had read.
describe("two findings on one passage", () => {
  const shared = {
    entityId: "e1", aspectId: "pendirian_ad" as const, sourceFile: "akta16.pdf",
    anchor: "Akta Nomor 16 tanggal 15 April 2009",
  };
  const unregistered = { ...shared, problem: "Akta belum didaftarkan dalam Daftar Perseroan" };
  const unpublished = { ...shared, problem: "Akta belum diumumkan dalam Berita Negara" };

  it("gives each a stable id regardless of the order they arrive in", () => {
    const [a1, b1] = assignModelFindingIds([unregistered, unpublished]);
    const [b2, a2] = assignModelFindingIds([unpublished, unregistered]);
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(a1).not.toBe(b1);
  });

  it("keeps a dismissal on the issue it was made against after a reorder", () => {
    const first = assignModelFindingIds([unregistered, unpublished]);
    const prev = [
      finding({ id: first[0], problem: unregistered.problem, status: "dismissed" }),
      finding({ id: first[1], problem: unpublished.problem }),
    ];
    // Second run emits them the other way round.
    const second = assignModelFindingIds([unpublished, unregistered]);
    const fresh = [
      finding({ id: second[0], problem: unpublished.problem }),
      finding({ id: second[1], problem: unregistered.problem }),
    ];
    const out = carryReviewState(fresh, prev);
    expect(out.findings.find((f) => f.problem === unregistered.problem)?.status).toBe("dismissed");
    expect(out.findings.find((f) => f.problem === unpublished.problem)?.status).toBe("open");
  });

  it("still separates records identical in both passage and problem", () => {
    const ids = assignModelFindingIds([unregistered, unregistered]);
    expect(new Set(ids).size).toBe(2);
  });
});
