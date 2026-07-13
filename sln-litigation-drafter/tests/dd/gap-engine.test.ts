import { describe, it, expect } from "vitest";
import { computeGaps, gapToFinding, severityFor } from "@/lib/dd/gap-engine";
import type { DDExpectedDoc, DDClassifiedDoc } from "@/types/dd";

const expected: DDExpectedDoc[] = [
  { id: "perizinan.nib", aspectId: "perizinan", label: "NIB", importance: "wajib", keywords: ["nib"], source: "base" },
  { id: "asuransi.polis", aspectId: "asuransi", label: "Polis asuransi", importance: "penting", keywords: ["polis"], expiryRule: { kind: "fixed_years", years: 1 }, source: "base" },
  { id: "perkara.daftar_perkara", aspectId: "perkara", label: "Daftar perkara", importance: "wajib", keywords: ["perkara"], source: "base" },
  { id: "perpajakan.skf", aspectId: "perpajakan", label: "SKF", importance: "penting", keywords: ["fiskal"], source: "base" },
  { id: "pengurus.rups_merger", aspectId: "pengurus", label: "RUPS merger", importance: "wajib", keywords: ["rups"], appliesTo: ["merger"], source: "base" },
];

const doc = (over: Partial<DDClassifiedDoc>): DDClassifiedDoc => ({
  fileName: "f.pdf", entityId: "e1", aspectId: "perizinan", expectedDocId: null,
  docLabel: "doc", docDate: null, parties: [], summary: "", confidence: "tinggi",
  reasoning: "", ...over,
});

const base = {
  expected, entityId: "e1",
  transactionType: "akuisisi_saham" as const,
  cutoffDateISO: "2026-07-08",
};

describe("computeGaps", () => {
  it("filters expected docs by appliesTo (rups_merger excluded for akuisisi_saham)", () => {
    const gaps = computeGaps({ ...base, classified: [] });
    expect(gaps.map((g) => g.expectedDocId)).not.toContain("pengurus.rups_merger");
    expect(gaps).toHaveLength(4);
  });

  it("marks unmatched as missing with severity from importance", () => {
    const gaps = computeGaps({ ...base, classified: [] });
    const nib = gaps.find((g) => g.expectedDocId === "perizinan.nib")!;
    expect(nib.status).toBe("missing");
    expect(nib.severity).toBe("kritis");
    const skf = gaps.find((g) => g.expectedDocId === "perpajakan.skf")!;
    expect(skf.severity).toBe("material");
  });

  it("marks matched high-confidence, unexpired as present", () => {
    const gaps = computeGaps({
      ...base,
      classified: [doc({ expectedDocId: "perizinan.nib", fileName: "nib.pdf" })],
    });
    const nib = gaps.find((g) => g.expectedDocId === "perizinan.nib")!;
    expect(nib.status).toBe("present");
    expect(nib.matchedFiles).toEqual(["nib.pdf"]);
  });

  it("marks all-low-confidence matches as incomplete", () => {
    const gaps = computeGaps({
      ...base,
      classified: [doc({ expectedDocId: "perizinan.nib", confidence: "rendah" })],
    });
    expect(gaps.find((g) => g.expectedDocId === "perizinan.nib")!.status).toBe("incomplete");
  });

  it("marks expired when latest docDate + years < cutoff", () => {
    const gaps = computeGaps({
      ...base,
      classified: [
        doc({ expectedDocId: "asuransi.polis", aspectId: "asuransi", docDate: "2024-01-15" }),
      ],
    });
    expect(gaps.find((g) => g.expectedDocId === "asuransi.polis")!.status).toBe("expired");
  });

  it("uses the LATEST dated match for expiry (renewal supersedes old polis)", () => {
    const gaps = computeGaps({
      ...base,
      classified: [
        doc({ expectedDocId: "asuransi.polis", aspectId: "asuransi", docDate: "2024-01-15" }),
        doc({ expectedDocId: "asuransi.polis", aspectId: "asuransi", docDate: "2026-02-01", fileName: "polis-2026.pdf" }),
      ],
    });
    expect(gaps.find((g) => g.expectedDocId === "asuransi.polis")!.status).toBe("present");
  });

  it("supports year-only docDate strings", () => {
    const gaps = computeGaps({
      ...base,
      classified: [doc({ expectedDocId: "asuransi.polis", aspectId: "asuransi", docDate: "2023" })],
    });
    expect(gaps.find((g) => g.expectedDocId === "asuransi.polis")!.status).toBe("expired");
  });

  it("marks notApplicableIds as not_applicable, never hidden", () => {
    const gaps = computeGaps({ ...base, classified: [], notApplicableIds: ["asuransi.polis"] });
    expect(gaps.find((g) => g.expectedDocId === "asuransi.polis")!.status).toBe("not_applicable");
    expect(gaps).toHaveLength(4);
  });

  it("treats a missing day in YYYY-MM as the actual last day of that month, not a rolled-over date", () => {
    // 2024-06 -> last day is June 30 (June has 30 days). +1y = 2025-06-30.
    // cutoff 2025-07-01 is after 2025-06-30, so the policy must be expired.
    const expiredGaps = computeGaps({
      ...base,
      cutoffDateISO: "2025-07-01",
      classified: [doc({ expectedDocId: "asuransi.polis", aspectId: "asuransi", docDate: "2024-06" })],
    });
    expect(expiredGaps.find((g) => g.expectedDocId === "asuransi.polis")!.status).toBe("expired");

    // cutoff 2025-06-15 is before 2025-06-30, so the same policy is still present.
    const presentGaps = computeGaps({
      ...base,
      cutoffDateISO: "2025-06-15",
      classified: [doc({ expectedDocId: "asuransi.polis", aspectId: "asuransi", docDate: "2024-06" })],
    });
    expect(presentGaps.find((g) => g.expectedDocId === "asuransi.polis")!.status).toBe("present");
  });
});

describe("severityFor / gapToFinding", () => {
  it("maps importance to severity", () => {
    expect(severityFor("wajib")).toBe("kritis");
    expect(severityFor("penting")).toBe("material");
    expect(severityFor("opsional")).toBe("minor");
  });

  it("emits a kelengkapan finding for non-present, null for present", () => {
    const gaps = computeGaps({ ...base, classified: [] });
    const f = gapToFinding(gaps.find((g) => g.expectedDocId === "perizinan.nib")!);
    expect(f).not.toBeNull();
    expect(f!.dimension).toBe("kelengkapan");
    expect(f!.anchor).toBe("");
    expect(f!.verified).toBe(false);
    expect(f!.status).toBe("open");

    const present = computeGaps({
      ...base,
      classified: [doc({ expectedDocId: "perizinan.nib" })],
    }).find((g) => g.expectedDocId === "perizinan.nib")!;
    expect(gapToFinding(present)).toBeNull();
  });

  it("downgrades whyItMatters text (not just severity) when a wajib item is marked not_applicable", () => {
    const gaps = computeGaps({ ...base, classified: [], notApplicableIds: ["perizinan.nib"] });
    const nib = gaps.find((g) => g.expectedDocId === "perizinan.nib")!;
    const finding = gapToFinding(nib)!;
    expect(finding.severity).toBe("minor");
    expect(finding.whyItMatters).toContain("perlu konfirmasi reviewer");
    expect(finding.whyItMatters).not.toContain("condition precedent");
  });
});
