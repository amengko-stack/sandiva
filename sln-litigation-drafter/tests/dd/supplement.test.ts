import { describe, it, expect } from "vitest";
import {
  UNREADABLE, diffAgainstBaseline, examinedDocs, snapshotBaseline, supplementIsWarranted,
} from "@/lib/dd/supplement";
import {
  supplementBlocker, supplementIncorporation, supplementTitle,
} from "@/lib/dd/report-boilerplate";
import type {
  DDBaseline, DDClassifiedDoc, DDFinding, DDGapItem, DDReportMeta,
} from "@/types/dd";

// The precedent (DD Report - Polyprima) does not revise the main report when more
// documents arrive: it issues a separate SUPPLEMENT that forms one instrument with
// the report it follows. The diff is organised by DOCUMENT because documents have
// stable identities — a file name, a checklist item id — while findings do not
// survive re-runs reliably enough to diff on their own.

const doc = (fileName: string): DDClassifiedDoc =>
  ({ fileName, aspectId: "pendirian_ad", confidence: 1, reason: "" }) as unknown as DDClassifiedDoc;

// Extracted text per file. Content matters now: it is what a document's identity
// digests, so a same-name replacement is a different document.
const TEXTS = new Map<string, string>([
  ["akta16.pdf", "TEKS AKTA 16"],
  ["nib.pdf", "TEKS NIB"],
  ["fs2023.pdf", "TEKS LAPORAN KEUANGAN 2023"],
  ["polis.pdf", "TEKS POLIS"],
  ["a.pdf", "TEKS A"],
  ["b.pdf", "TEKS B"],
]);
const digestOf = (name: string) => examinedDocs([doc(name)], TEXTS)[0].digest;

const gap = (expectedDocId: string, status: DDGapItem["status"], label?: string): DDGapItem =>
  ({
    entityId: "e1", aspectId: "pendirian_ad", expectedDocId,
    expectedLabel: label ?? `Label ${expectedDocId}`,
    status, matchedFiles: [], severity: "material", note: "",
  }) as DDGapItem;

const finding = (over: Partial<DDFinding> = {}): DDFinding => ({
  id: "f1", entityId: "e1", aspectId: "pendirian_ad", dimension: "risiko",
  severity: "material", anchor: "a", sourceFile: "akta16.pdf", problem: "p",
  whyItMatters: "w", suggestedFix: "s", verified: false, status: "open",
  ...over,
});

const meta: DDReportMeta = {
  matterRef: "50160", clientName: "PT Klien", addressee: "Direksi",
  relianceScope: "PT Klien", clientRelease: true, ddStartDateISO: "2026-07-01",
  taxInScope: true, assumptionsVariant: "ringkas", reportStage: "interim",
  signatoryName: "Advokat", signatoryTitle: "Partner",
};

describe("snapshotBaseline", () => {
  it("records the documents examined, the outstanding items and the findings", () => {
    const b = snapshotBaseline({
      entityId: "e1", issuedAtISO: "2026-08-01", cutoffDateISO: "2026-07-31",
      classified: [doc("b.pdf"), doc("a.pdf"), doc("a.pdf")],
      contentByFile: TEXTS,
      gaps: [gap("fs_audited", "missing"), gap("nib", "present"), gap("polis", "incomplete")],
      findings: [finding({ id: "f1" })],
    });
    expect(b.documents.map((d) => d.fileName)).toEqual(["a.pdf", "b.pdf"]); // deduped and sorted
    expect(b.outstandingDocIds.sort()).toEqual(["fs_audited", "polis"]);
    expect(b.findings).toHaveLength(1);
    expect(b.issuedAtISO).toBe("2026-08-01");
  });

  // The report shows the lawyer's wording where they replaced the model's, so the
  // baseline must record what the client actually read.
  it("stores the lawyer's wording where there is one", () => {
    const b = snapshotBaseline({
      entityId: "e1", issuedAtISO: "2026-08-01", cutoffDateISO: "2026-07-31",
      classified: [], contentByFile: TEXTS, gaps: [],
      findings: [finding({ problem: "redaksi model", editedProblem: "redaksi pengacara", status: "edited" })],
    });
    expect(b.findings[0].problem).toBe("redaksi pengacara");
  });

  it("treats expired as reported rather than outstanding", () => {
    const b = snapshotBaseline({
      entityId: "e1", issuedAtISO: "2026-08-01", cutoffDateISO: "2026-07-31",
      classified: [], contentByFile: TEXTS, gaps: [gap("izin", "expired"), gap("na", "not_applicable")],
      findings: [],
    });
    expect(b.outstandingDocIds).toEqual([]);
  });
});

describe("diffAgainstBaseline", () => {
  const baseline: DDBaseline = {
    entityId: "e1", issuedAtISO: "2026-08-01", cutoffDateISO: "2026-07-31",
    documents: [
      { fileName: "akta16.pdf", digest: digestOf("akta16.pdf") },
      { fileName: "nib.pdf", digest: digestOf("nib.pdf") },
    ],
    outstandingDocIds: ["fs_audited", "polis"],
    findings: [
      { id: "f1", aspectId: "pendirian_ad", sourceFile: "akta16.pdf", severity: "material", problem: "lama", status: "open" },
      { id: "f2", aspectId: "pendirian_ad", sourceFile: "nib.pdf", severity: "minor", problem: "dibuang", status: "dismissed" },
    ],
  };

  const current = {
    cutoffDateISO: "2026-09-15",
    classified: [doc("akta16.pdf"), doc("nib.pdf"), doc("fs2023.pdf"), doc("polis.pdf")],
    contentByFile: TEXTS,
    gaps: [
      gap("fs_audited", "present", "Laporan keuangan auditan 2023"),
      gap("polis", "present", "Polis asuransi kebakaran"),
      gap("risalah_dir", "missing", "Risalah rapat Direksi 3 tahun"),
    ],
    findings: [
      finding({ id: "f1", sourceFile: "akta16.pdf" }),
      finding({ id: "f9", sourceFile: "fs2023.pdf", problem: "temuan dari dokumen baru" }),
    ],
  };

  it("names the documents examined now that were not examined before", () => {
    const d = diffAgainstBaseline(baseline, current);
    expect(d.newDocuments).toEqual(["fs2023.pdf", "polis.pdf"]);
    expect(d.documentsExaminedNow).toBe(4);
  });

  it("reports which requested documents have since been supplied", () => {
    const d = diffAgainstBaseline(baseline, current);
    expect(d.gapsClosed).toEqual(["Laporan keuangan auditan 2023", "Polis asuransi kebakaran"]);
  });

  // A requirement the new documents themselves revealed is a consequence of this
  // batch, not a leftover, and reads differently to the client.
  it("separates a requirement the new documents revealed from a leftover", () => {
    const d = diffAgainstBaseline(baseline, current);
    expect(d.gapsFirstListedNow).toEqual(["Risalah rapat Direksi 3 tahun"]);
    // NOT in gapsStillOutstanding: that list is for items outstanding at BOTH
    // reports, so the two no longer overlap and each heading means one thing.
    expect(d.gapsStillOutstanding).toEqual([]);
  });

  it("attributes a finding to this batch only when its source is a new document", () => {
    const d = diffAgainstBaseline(baseline, current);
    expect(d.findingsFromNewDocuments.map((f) => f.id)).toEqual(["f9"]);
  });

  it("does not attribute a dismissed finding to the batch", () => {
    const d = diffAgainstBaseline(baseline, {
      ...current,
      findings: [finding({ id: "f9", sourceFile: "fs2023.pdf", status: "dismissed" })],
    });
    expect(d.findingsFromNewDocuments).toEqual([]);
  });

  // Reported for the lawyer to resolve, never treated as cured: only a lawyer can
  // conclude that an earlier finding no longer stands.
  it("lists an earlier finding this examination no longer raises", () => {
    const d = diffAgainstBaseline(baseline, { ...current, findings: [finding({ id: "f9", sourceFile: "fs2023.pdf" })] });
    expect(d.findingsNoLongerRaised.map((f) => f.id)).toEqual(["f1"]);
  });

  it("does not list a finding the lawyer had already dismissed", () => {
    const d = diffAgainstBaseline(baseline, current);
    expect(d.findingsNoLongerRaised.map((f) => f.id)).not.toContain("f2");
  });

  it("counts the findings that persist from the earlier report", () => {
    expect(diffAgainstBaseline(baseline, current).findingsCarriedForward).toBe(1);
  });

  it("carries both cut-off dates so the supplement can state its period", () => {
    const d = diffAgainstBaseline(baseline, current);
    expect(d.baselineCutoffDateISO).toBe("2026-07-31");
    expect(d.cutoffDateISO).toBe("2026-09-15");
  });

  it("reports nothing changed when nothing has", () => {
    const d = diffAgainstBaseline(baseline, {
      cutoffDateISO: "2026-07-31",
      classified: [doc("akta16.pdf"), doc("nib.pdf")],
      contentByFile: TEXTS,
      gaps: [gap("fs_audited", "missing"), gap("polis", "missing")],
      findings: [finding({ id: "f1", sourceFile: "akta16.pdf" })],
    });
    expect(d.newDocuments).toEqual([]);
    expect(d.gapsClosed).toEqual([]);
    expect(d.gapsFirstListedNow).toEqual([]);
    expect(supplementIsWarranted(d)).toBe(false);
  });

  it("is warranted as soon as one document arrives", () => {
    expect(supplementIsWarranted(diffAgainstBaseline(baseline, current))).toBe(true);
  });
});

describe("supplement boilerplate", () => {
  const inc = supplementIncorporation({
    meta, baselineCutoffISO: "2026-07-31", cutoffISO: "2026-09-15",
  });

  it("makes the supplement and the earlier report one instrument", () => {
    expect(inc.join(" ")).toContain("satu kesatuan yang tidak dapat dipisahkan");
    expect(inc.join(" ")).toContain("50160");
  });

  // Without this a reader can treat the supplement as a standalone report, which
  // would present a fraction of the examination as the whole of it.
  it("says it neither replaces nor repeats the earlier report", () => {
    expect(inc.join(" ")).toContain("TIDAK menggantikan");
    expect(inc.join(" ")).toContain("tidak berubah");
  });

  it("states the period it covers, between the two cut-off dates", () => {
    const text = inc.join(" ");
    expect(text).toContain("31 Juli 2026");
    expect(text).toContain("15 September 2026");
  });

  it("falls back to a visible placeholder rather than an empty date", () => {
    const out = supplementIncorporation({ meta, baselineCutoffISO: "", cutoffISO: "" }).join(" ");
    expect(out).toContain("[TANGGAL AKHIR UJI TUNTAS LAPORAN SEBELUMNYA]");
  });

  it("titles itself as a supplement, not as a report", () => {
    expect(supplementTitle()).toContain("LAPORAN TAMBAHAN");
    expect(supplementTitle()).toContain("SUPPLEMENT");
  });

  it("refuses to issue a supplement with nothing to report", () => {
    const nothing = diffAgainstBaseline(
      {
        entityId: "e1", issuedAtISO: "2026-08-01", cutoffDateISO: "2026-07-31",
        documents: [{ fileName: "akta16.pdf", digest: digestOf("akta16.pdf") }],
        outstandingDocIds: [], findings: [],
      },
      {
        cutoffDateISO: "2026-07-31", classified: [doc("akta16.pdf")],
        contentByFile: TEXTS, gaps: [], findings: [],
      }
    );
    expect(supplementBlocker(nothing)).toContain("tidak dapat diterbitkan");
    expect(supplementBlocker({ ...nothing, newDocuments: ["baru.pdf"] })).toBe("");
  });
});

// Every case below is a defect Codex found in the first version of this module.
describe("claims the data does not support", () => {
  const base = (docs: { fileName: string; digest: string }[], outstanding: string[]): DDBaseline => ({
    entityId: "e1", issuedAtISO: "2026-08-01", cutoffDateISO: "2026-07-31",
    documents: docs, outstandingDocIds: outstanding, findings: [],
  });

  // A checklist id vanishing from the gap array proves nothing: the checklist may
  // have been edited, a regime overlay may have changed, or the gap analysis may
  // have been re-run incompletely. Reporting it as supplied asserts receipt of a
  // document nobody has seen.
  it("does not call a requirement supplied merely because it left the list", () => {
    const d = diffAgainstBaseline(base([], ["fs_audited"]), {
      cutoffDateISO: "2026-09-15", classified: [], contentByFile: TEXTS,
      gaps: [], findings: [],
    });
    expect(d.gapsClosed).toEqual([]);
    expect(d.gapsNoLongerListed).toEqual(["fs_audited"]);
  });

  it("calls it supplied only when the gap analysis says so affirmatively", () => {
    const d = diffAgainstBaseline(base([], ["fs_audited"]), {
      cutoffDateISO: "2026-09-15", classified: [], contentByFile: TEXTS,
      gaps: [gap("fs_audited", "present", "Laporan keuangan auditan")], findings: [],
    });
    expect(d.gapsClosed).toEqual(["Laporan keuangan auditan"]);
    expect(d.gapsNoLongerListed).toEqual([]);
  });

  // Marked not applicable is a decision, not a delivery.
  it("separates not-applicable from supplied", () => {
    const d = diffAgainstBaseline(base([], ["fs_audited"]), {
      cutoffDateISO: "2026-09-15", classified: [], contentByFile: TEXTS,
      gaps: [gap("fs_audited", "not_applicable", "Laporan keuangan auditan")], findings: [],
    });
    expect(d.gapsClosed).toEqual([]);
    expect(d.gapsNoLongerListed).toEqual(["Laporan keuangan auditan"]);
  });

  // A data room replaces documents under the same name — a re-scan, a signed
  // version, a corrected page. Diffed on names alone it compares equal, drops out
  // of what is new, and its changed contents go unreported.
  it("treats a same-name document with different content as new", () => {
    const before = base([{ fileName: "akta16.pdf", digest: "digest-lama" }], []);
    const d = diffAgainstBaseline(before, {
      cutoffDateISO: "2026-09-15", classified: [doc("akta16.pdf")],
      contentByFile: TEXTS, gaps: [], findings: [],
    });
    expect(d.newDocuments).toEqual(["akta16.pdf"]);
  });

  it("does not treat an unchanged document as new", () => {
    const before = base([{ fileName: "akta16.pdf", digest: digestOf("akta16.pdf") }], []);
    const d = diffAgainstBaseline(before, {
      cutoffDateISO: "2026-09-15", classified: [doc("akta16.pdf")],
      contentByFile: TEXTS, gaps: [], findings: [],
    });
    expect(d.newDocuments).toEqual([]);
  });

  // A document listed but never extracted was not read, which is not the same as
  // unchanged — it must not silently compare equal to a document that was read.
  it("marks a document whose text was never extracted", () => {
    const docs = examinedDocs([doc("kosong.pdf")], new Map());
    expect(docs[0].digest).toBe(UNREADABLE);
    // Whitespace-only extraction is no more readable than none.
    expect(examinedDocs([doc("x.pdf")], new Map([["x.pdf", "   \n  "]]))[0].digest).toBe(UNREADABLE);
  });

  it("reports unreadable documents rather than counting them as examined", () => {
    const d = diffAgainstBaseline(base([], []), {
      cutoffDateISO: "2026-09-15", classified: [doc("kosong.pdf"), doc("akta16.pdf")],
      contentByFile: TEXTS, gaps: [], findings: [],
    });
    expect(d.documentsUnreadable).toEqual(["kosong.pdf"]);
  });

  // A document replaced under the same name counts as new, so without excluding
  // what the earlier report already raised, every finding bearing that file name
  // would be presented to the client as arising from the replacement.
  it("does not attribute a carried finding to a same-name replacement", () => {
    const before: DDBaseline = {
      ...base([{ fileName: "akta16.pdf", digest: "digest-lama" }], []),
      findings: [{ id: "f1", aspectId: "pendirian_ad", sourceFile: "akta16.pdf", severity: "material", problem: "lama", status: "open" }],
    };
    const d = diffAgainstBaseline(before, {
      cutoffDateISO: "2026-09-15", classified: [doc("akta16.pdf")],
      contentByFile: TEXTS, gaps: [],
      findings: [finding({ id: "f1", sourceFile: "akta16.pdf" }), finding({ id: "f9", sourceFile: "akta16.pdf" })],
    });
    expect(d.newDocuments).toEqual(["akta16.pdf"]);
    expect(d.findingsFromNewDocuments.map((f) => f.id)).toEqual(["f9"]);
  });

  // Carried forward is not the same as unchanged.
  it("separates findings revised in severity or wording from unchanged ones", () => {
    const before: DDBaseline = {
      ...base([], []),
      findings: [
        { id: "f1", aspectId: "pendirian_ad", sourceFile: "akta16.pdf", severity: "minor", problem: "rumusan lama", status: "open" },
        { id: "f2", aspectId: "pendirian_ad", sourceFile: "akta16.pdf", severity: "material", problem: "tetap", status: "open" },
      ],
    };
    const d = diffAgainstBaseline(before, {
      cutoffDateISO: "2026-09-15", classified: [], contentByFile: TEXTS, gaps: [],
      findings: [
        finding({ id: "f1", severity: "kritis", problem: "rumusan baru" }),
        finding({ id: "f2", severity: "material", problem: "tetap" }),
      ],
    });
    expect(d.findingsCarriedForward).toBe(2);
    expect(d.findingsCarriedUnchanged).toBe(1);
    expect(d.findingsCarriedRevised.map((f) => f.id)).toEqual(["f1"]);
  });

  it("compares against the wording the client actually read", () => {
    const before: DDBaseline = {
      ...base([], []),
      findings: [{ id: "f1", aspectId: "pendirian_ad", sourceFile: "akta16.pdf", severity: "material", problem: "redaksi pengacara", status: "edited" }],
    };
    const d = diffAgainstBaseline(before, {
      cutoffDateISO: "2026-09-15", classified: [], contentByFile: TEXTS, gaps: [],
      findings: [finding({ id: "f1", problem: "redaksi model", editedProblem: "redaksi pengacara", status: "edited" })],
    });
    expect(d.findingsCarriedUnchanged).toBe(1);
  });

  // The client read it in the interim report and will not find it next time. The
  // cause is a review decision, not a change in the documents.
  it("accounts for a finding the lawyer dismissed since the earlier report", () => {
    const before: DDBaseline = {
      ...base([], []),
      findings: [{ id: "f1", aspectId: "pendirian_ad", sourceFile: "akta16.pdf", severity: "material", problem: "lama", status: "open" }],
    };
    const d = diffAgainstBaseline(before, {
      cutoffDateISO: "2026-09-15", classified: [], contentByFile: TEXTS, gaps: [],
      findings: [finding({ id: "f1", status: "dismissed" })],
    });
    expect(d.findingsDismissedSinceBaseline.map((f) => f.id)).toEqual(["f1"]);
    // Still raised by the examination, so not in the "no longer raised" list.
    expect(d.findingsNoLongerRaised).toEqual([]);
  });

  // Only what was active in the issued report can be carried forward from it.
  it("does not count a baseline-dismissed finding as carried forward", () => {
    const before: DDBaseline = {
      ...base([], []),
      findings: [{ id: "f1", aspectId: "pendirian_ad", sourceFile: "akta16.pdf", severity: "material", problem: "x", status: "dismissed" }],
    };
    const d = diffAgainstBaseline(before, {
      cutoffDateISO: "2026-09-15", classified: [], contentByFile: TEXTS, gaps: [],
      findings: [finding({ id: "f1", status: "open" })],
    });
    expect(d.findingsCarriedForward).toBe(0);
  });

  // A finding vanishing is a change to what the client was told — arguably the most
  // important kind. Leaving it out let the blocker say "nothing has changed".
  it("warrants a supplement when only the findings changed", () => {
    const before: DDBaseline = {
      ...base([{ fileName: "akta16.pdf", digest: digestOf("akta16.pdf") }], []),
      findings: [{ id: "f1", aspectId: "pendirian_ad", sourceFile: "akta16.pdf", severity: "kritis", problem: "lama", status: "open" }],
    };
    const d = diffAgainstBaseline(before, {
      cutoffDateISO: "2026-09-15", classified: [doc("akta16.pdf")],
      contentByFile: TEXTS, gaps: [], findings: [],
    });
    expect(d.newDocuments).toEqual([]);
    expect(d.findingsNoLongerRaised).toHaveLength(1);
    expect(supplementIsWarranted(d)).toBe(true);
    expect(supplementBlocker(d)).toBe("");
  });
});

// The supplement cannot state when a document was received: the baseline records
// file names, digests and cut-off dates, not receipt timestamps. A document absent
// from the earlier examination may have been in the data room all along and simply
// unclassified or unreadable.
describe("supplement makes no claim about receipt dates", () => {
  const text = supplementIncorporation({
    meta, baselineCutoffISO: "2026-07-31", cutoffISO: "2026-09-15",
  }).join(" ");

  it("says the documents were not covered before, not that they arrived later", () => {
    expect(text).toContain("TIDAK termasuk dalam pemeriksaan");
    expect(text).toContain("tidak menyatakan kapan dokumen tersebut diterima");
    expect(text).not.toMatch(/dokumen yang diterima setelah/);
  });
});
