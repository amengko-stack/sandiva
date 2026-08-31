import { describe, it, expect } from "vitest";
import { computeGaps, gapToFinding, severityFor } from "@/lib/dd/gap-engine";
import { computeAspectRollup } from "@/lib/dd/consolidate";
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
    expect(finding.whyItMatters).toContain("konfirmasi reviewer");
    expect(finding.whyItMatters).not.toContain("condition precedent");
  });

  // Before the rationale table, every missing document produced the same three
  // sentences, so a document-poor data room yielded a report of near-identical
  // paragraphs. These assert the text is genuinely per-document.
  it("gives a missing wajib item its own legal basis, consequence and citations", () => {
    const gaps = computeGaps({ ...base, classified: [] });
    const akta = gaps.find((g) => g.expectedDocId === "pendirian_ad.akta_pendirian");
    if (!akta) return; // checklist item not in this fixture's transaction type
    const f = gapToFinding(akta)!;
    expect(f.whyItMatters).toContain("status badan hukum");
    expect(f.regulationRefs).toBeDefined();
    expect(f.regulationRefs!.length).toBeGreaterThan(0);
    // Remediation must be specific, not the generic "ask the target".
    expect(f.suggestedFix).toContain("notaris");
  });

  it("does not render identical prose for two different missing documents", () => {
    const gaps = computeGaps({ ...base, classified: [] });
    const findings = gaps
      .map(gapToFinding)
      .filter((f): f is NonNullable<typeof f> => f !== null);
    expect(findings.length).toBeGreaterThan(2);
    const distinct = new Set(findings.map((f) => f.whyItMatters));
    // Items without a rationale entry still share the generic fallback, so this
    // asserts meaningful variation rather than total uniqueness.
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("frames an expired document differently from an absent one", () => {
    const gaps = computeGaps({ ...base, classified: [] });
    const missing = gapToFinding(gaps[0])!;
    const expiredGap = { ...gaps[0], status: "expired" as const, note: "Dokumen terbaru bertanggal 2012-01-01." };
    const expired = gapToFinding(expiredGap)!;
    expect(missing.whyItMatters).not.toBe(expired.whyItMatters);
    expect(expired.whyItMatters).toContain("melewati masa berlaku");
    expect(expired.whyItMatters).toContain("Tanggal Akhir Uji Tuntas");
  });
});

// A document supplied as an image-only scan never reaches the classifier — there is
// no text to classify — so the checklist item it covers came out "missing" with the
// note "Tidak ditemukan dalam data room." On a live dissolution 24 of 83 supplied
// documents were such scans. Telling a client their document is absent when they did
// supply it is a different and worse error than saying it could not be read.
describe("documents supplied but unreadable", () => {
  const unreadableFiles = ["Scan NIB PT Target.pdf", "Polis Asuransi Kebakaran 2024.pdf"];

  it("does not call an item missing when a scan may cover it", () => {
    const gaps = computeGaps({ ...base, classified: [], unreadableFiles });
    const nib = gaps.find((g) => g.expectedDocId === "perizinan.nib")!;
    expect(nib.status).toBe("unreadable");
    expect(nib.note).not.toContain("Tidak ditemukan dalam data room");
    expect(nib.note).toContain("belum dapat dinyatakan tidak ada");
  });

  it("names the scan, so the reader can go and open it", () => {
    const gaps = computeGaps({ ...base, classified: [], unreadableFiles });
    const nib = gaps.find((g) => g.expectedDocId === "perizinan.nib")!;
    expect(nib.note).toContain("Scan NIB PT Target.pdf");
    expect(nib.unreadableCandidates).toEqual(["Scan NIB PT Target.pdf"]);
  });

  it("still reports missing where no scan matches", () => {
    const gaps = computeGaps({ ...base, classified: [], unreadableFiles });
    const perkara = gaps.find((g) => g.expectedDocId === "perkara.daftar_perkara")!;
    expect(perkara.status).toBe("missing");
    expect(perkara.unreadableCandidates).toBeUndefined();
  });

  // Several checklist keywords are three-letter acronyms. Substring matching would
  // find "nib" inside "Kombinasi" and quietly downgrade a genuine gap.
  it("matches on whole words, not substrings", () => {
    const gaps = computeGaps({
      ...base,
      classified: [],
      unreadableFiles: ["Kombinasi Dokumen Korporasi.pdf", "Monopolis.pdf"],
    });
    expect(gaps.find((g) => g.expectedDocId === "perizinan.nib")!.status).toBe("missing");
    expect(gaps.find((g) => g.expectedDocId === "asuransi.polis")!.status).toBe("missing");
  });

  it("leaves a matched item alone even when a scan also mentions it", () => {
    const gaps = computeGaps({
      ...base,
      classified: [doc({ expectedDocId: "perizinan.nib" })],
      unreadableFiles,
    });
    expect(gaps.find((g) => g.expectedDocId === "perizinan.nib")!.status).toBe("present");
  });

  it("counts the rest rather than printing a long list", () => {
    const many = ["NIB 2020.pdf", "NIB 2021.pdf", "NIB 2022.pdf", "NIB 2023.pdf", "NIB 2024.pdf"];
    const nib = computeGaps({ ...base, classified: [], unreadableFiles: many }).find(
      (g) => g.expectedDocId === "perizinan.nib"
    )!;
    expect(nib.note).toContain("dan 2 dokumen lainnya");
    expect(nib.note).not.toContain("NIB 2024.pdf");
    // The field keeps all of them; only the sentence is abbreviated.
    expect(nib.unreadableCandidates).toHaveLength(5);
  });

  it("behaves exactly as before when nothing was unreadable", () => {
    const withOut = computeGaps({ ...base, classified: [] });
    const withEmpty = computeGaps({ ...base, classified: [], unreadableFiles: [] });
    expect(withEmpty).toEqual(withOut);
  });

  // The finding must not read as an assertion of absence.
  it("frames the finding as unverified rather than absent", () => {
    const gaps = computeGaps({ ...base, classified: [], unreadableFiles });
    const f = gapToFinding(gaps.find((g) => g.expectedDocId === "perizinan.nib")!)!;
    expect(f.problem).toContain("tidak dapat dibaca");
    expect(f.whyItMatters).toContain("BELUM dapat");
    expect(f.whyItMatters).toContain("OCR");
  });
});

describe("documents supplied but extraction failed", () => {
  it("treats a matching failed file as supplied-but-unreadable and names it", () => {
    const gaps = computeGaps({
      ...base,
      classified: [],
      failedFiles: ["NIB PT Target.pdf"],
    });
    const nib = gaps.find((g) => g.expectedDocId === "perizinan.nib")!;

    expect(nib.status).toBe("unreadable");
    expect(nib.note).toContain("NIB PT Target.pdf");
    expect(nib.note).not.toContain("Tidak ditemukan dalam data room");
    expect(nib.unreadableCandidates).toEqual(["NIB PT Target.pdf"]);
  });

  it("uses conservative uncertainty when a generic failed scan cannot be ruled out", () => {
    const gaps = computeGaps({
      ...base,
      classified: [],
      failedFiles: ["Scan_001.pdf"],
    });
    const nib = gaps.find((g) => g.expectedDocId === "perizinan.nib")!;

    expect(nib.status).toBe("unreadable");
    expect(nib.note).toContain("Scan_001.pdf");
    expect(nib.note).toContain("belum dapat dipastikan");
    expect(nib.note).not.toContain("Tidak ditemukan dalam data room");
  });

  it("still reports a truly missing item when no unreadable uncertainty exists", () => {
    const nib = computeGaps({ ...base, classified: [], failedFiles: [] }).find(
      (g) => g.expectedDocId === "perizinan.nib"
    )!;

    expect(nib.status).toBe("missing");
    expect(nib.note).toBe("Tidak ditemukan dalam data room.");
  });

  it("counts a failed candidate once as unreadable and never as missing", () => {
    const nib = computeGaps({
      ...base,
      classified: [],
      failedFiles: ["NIB PT Target.pdf"],
    }).find((g) => g.expectedDocId === "perizinan.nib")!;
    const rollup = computeAspectRollup({ e1: [nib] })[0];
    const total =
      rollup.present + rollup.missing + (rollup.unreadable ?? 0) + rollup.incomplete +
      rollup.expired + rollup.notApplicable;

    expect(rollup.missing).toBe(0);
    expect(rollup.unreadable).toBe(1);
    expect(total).toBe(rollup.totalExpected);
  });
});
