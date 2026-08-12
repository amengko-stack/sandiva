import { describe, it, expect } from "vitest";
import { renderFindingsTable, renderVerdictLine } from "@/lib/dd/findings-render";
import { DD_DEFAULT_REPORT_OPTIONS } from "@/types/dd";
import type { DDFinding, DDSeverity } from "@/types/dd";

const finding = (over: Partial<DDFinding> = {}): DDFinding => ({
  id: "e1-kelengkapan-1",
  entityId: "e1",
  aspectId: "pendirian_ad",
  dimension: "kelengkapan",
  severity: "material",
  anchor: "",
  sourceFile: null,
  problem: "Akta konsolidasi belum tersedia.",
  whyItMatters: "Tidak dapat memverifikasi anggaran dasar terbaru.",
  suggestedFix: "Minta akta konsolidasi kepada manajemen.",
  legalConsequence: "Tidak ada sanksi langsung; risiko administratif.",
  regulationRefs: ["Pasal 21 UUPT"],
  verified: true,
  status: "open",
  ...over,
});

describe("renderFindingsTable", () => {
  it("returns empty array when there are no findings", () => {
    expect(renderFindingsTable([])).toEqual([]);
  });

  it("excludes dismissed findings and states the count of the rest", () => {
    const blocks = renderFindingsTable([
      finding({ id: "1" }),
      finding({ id: "2", status: "dismissed" }),
    ]);
    const lead = blocks.find((b) => b.kind === "para");
    expect(lead && lead.kind === "para" && lead.text).toContain("satu hal");
  });

  it("orders rows kritis, then material, then minor, without printing the severity", () => {
    const blocks = renderFindingsTable([
      finding({ id: "1", severity: "minor", problem: "Isu ringan" }),
      finding({ id: "2", severity: "kritis", problem: "Isu berat" }),
      finding({ id: "3", severity: "material", problem: "Isu sedang" }),
    ]);
    const table = blocks.find((b) => b.kind === "table");
    expect(table).toBeDefined();
    if (table && table.kind === "table") {
      expect(table.headers).toEqual(["No.", "Temuan", "Pasal yang Relevan", "Konsekuensi Hukum", "Rekomendasi"]);
      expect(table.rows[0][1]).toBe("Isu berat");
      expect(table.rows[1][1]).toBe("Isu sedang");
      expect(table.rows[2][1]).toBe("Isu ringan");
      const serialized = JSON.stringify(table);
      expect(serialized).not.toMatch(/\bkritis\b|\bmaterial\b|\bminor\b/i);
    }
  });

  it("uses editedProblem over problem when the finding was edited", () => {
    const blocks = renderFindingsTable([
      finding({ status: "edited", editedProblem: "Versi yang telah disunting.", problem: "Versi asli." }),
    ]);
    const table = blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" && table.rows[0][1]).toBe("Versi yang telah disunting.");
  });

  it("prints the reference report's exact phrase when there are no relevant articles", () => {
    const blocks = renderFindingsTable([finding({ regulationRefs: [] })]);
    const table = blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" && table.rows[0][2]).toBe("Tidak ada cacat formal");
  });

  it("renders a dash when legalConsequence is absent", () => {
    const blocks = renderFindingsTable([finding({ legalConsequence: undefined })]);
    const table = blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" && table.rows[0][3]).toBe("—");
  });
});

describe("renderVerdictLine", () => {
  it("reports memenuhi ketentuan dengan catatan for a material finding", () => {
    const line = renderVerdictLine([finding({ severity: "material" })]);
    expect(line).toBe("Berdasarkan Dokumen Yang Diperiksa, aspek ini memenuhi ketentuan dengan catatan.");
  });

  it("reports tidak memenuhi ketentuan when a kritis finding is active", () => {
    const line = renderVerdictLine([finding({ severity: "kritis" })]);
    expect(line).toContain("tidak memenuhi ketentuan");
  });

  it("ignores dismissed findings when deriving the verdict", () => {
    const line = renderVerdictLine([finding({ severity: "kritis", status: "dismissed" })]);
    expect(line).toBe("Berdasarkan Dokumen Yang Diperiksa, aspek ini memenuhi ketentuan.");
  });
});

// The risk column is a per-report choice, not a convention. Evidence from the
// The default is off, on two independent grounds: the Makarim precedents and the
// HKHSK standard use no risk rating at all, and the user stated the convention
// directly. An earlier note here justified the two notations by citing three "firm
// reports" that use them — those documents are Claude output, so they were no
// evidence of anything. The notations remain because a client may ask for a rating.
describe("risk column as a report option", () => {
  const f = (severity: DDSeverity, over: Partial<DDFinding> = {}): DDFinding => ({
    id: "x", entityId: "e1", aspectId: "pendirian_ad", dimension: "risiko", severity,
    anchor: "q", sourceFile: "a.pdf", problem: "P", whyItMatters: "W", suggestedFix: "S",
    verified: false, status: "open", ...over,
  });

  const headersOf = (blocks: ReturnType<typeof renderFindingsTable>) => {
    const t = blocks.find((b) => b.kind === "table");
    return t && t.kind === "table" ? t.headers : [];
  };
  const rowsOf = (blocks: ReturnType<typeof renderFindingsTable>) => {
    const t = blocks.find((b) => b.kind === "table");
    return t && t.kind === "table" ? t.rows : [];
  };

  // Risk rating is not Indonesian LDD convention. It was once offered as an
  // option, justified by documents in the client's folders that turned out to be
  // Claude output. There is no option now: one nobody should choose is not a
  // feature, and leaving it would let a future reader think it had a basis.
  it("has no risk column at all, in any configuration", () => {
    for (const legalConsequenceColumn of [true, false]) {
      const blocks = renderFindingsTable([f("kritis"), f("material"), f("minor")], {
        ...DD_DEFAULT_REPORT_OPTIONS, legalConsequenceColumn,
      });
      expect(headersOf(blocks)).not.toContain("Tingkat Risiko");
      const printed = JSON.stringify(blocks);
      for (const word of ["Tinggi", "Sedang", "Rendah", "[T]", "[S]", "[R]"]) {
        expect(printed, word).not.toContain(word);
      }
    }
  });

  it("never prints the internal severity scale either", () => {
    const printed = JSON.stringify(renderFindingsTable([f("kritis"), f("minor")]));
    expect(printed).not.toMatch(/kritis|material|minor/);
  });

  it("can drop the Konsekuensi Hukum column for reports that do not carry one", () => {
    const h = headersOf(renderFindingsTable([f("kritis")], {
      ...DD_DEFAULT_REPORT_OPTIONS, legalConsequenceColumn: false,
    }));
    expect(h).toEqual(["No.", "Temuan", "Pasal yang Relevan", "Rekomendasi"]);
  });

  it("keeps row and header counts aligned in both configurations", () => {
    for (const legalConsequenceColumn of [true, false]) {
      const blocks = renderFindingsTable([f("kritis"), f("minor")], {
        ...DD_DEFAULT_REPORT_OPTIONS, legalConsequenceColumn,
      });
      const h = headersOf(blocks);
      for (const r of rowsOf(blocks)) {
        expect(r.length, String(legalConsequenceColumn)).toBe(h.length);
      }
    }
  });

  it("emits the three-state verdict the standard requires", () => {
    expect(renderVerdictLine([f("material")])).toContain("memenuhi ketentuan dengan catatan");
    expect(renderVerdictLine([f("kritis")])).toContain("tidak memenuhi ketentuan");
  });

  // The severity scale still earns its place: it decides reading order and which
  // findings go to adversarial verification. It is simply never shown.
  it("still orders rows most serious first", () => {
    // Labelled by problem text, because severity is deliberately never printed —
    // which is exactly why the ordering has to be asserted some other way.
    const blocks = renderFindingsTable([
      f("minor", { problem: "yang ringan" }),
      f("kritis", { problem: "yang berat" }),
      f("material", { problem: "yang sedang" }),
    ]);
    expect(rowsOf(blocks).map((r) => r[1])).toEqual(["yang berat", "yang sedang", "yang ringan"]);
    expect(rowsOf(blocks).map((r) => r[0])).toEqual(["1", "2", "3"]);
  });
});

// A claim whose quote was not found in the document it names must not reach the
// report as established fact. It is marked rather than dropped: the model may have
// spotted something real and quoted it badly, and discarding it would lose that.
describe("ungrounded findings are marked, not asserted", () => {
  const g = (verdict: DDFinding["grounding"] extends undefined ? never : NonNullable<DDFinding["grounding"]>["verdict"]) =>
    ({ verdict, coverage: 0, note: "n" });

  const f = (verdict: NonNullable<DDFinding["grounding"]>["verdict"] | null): DDFinding => ({
    id: "x", entityId: "e1", aspectId: "perizinan", dimension: "risiko", severity: "material",
    anchor: "kutipan", sourceFile: "a.pdf", problem: "NIB tidak ditemukan", whyItMatters: "W",
    suggestedFix: "S", verified: false, status: "open",
    ...(verdict ? { grounding: g(verdict) } : {}),
  });

  const cellsOf = (blocks: ReturnType<typeof renderFindingsTable>) => {
    const t = blocks.find((b) => b.kind === "table");
    return t && t.kind === "table" ? t.rows.map((r) => r[1]) : [];
  };

  it("prefixes a finding whose quote was not in the document", () => {
    expect(cellsOf(renderFindingsTable([f("not_found")]))[0])
      .toMatch(/^\[TIDAK TERVERIFIKASI TERHADAP DOKUMEN\] NIB tidak ditemukan/);
  });

  it("prefixes a finding attributed to a document that was never extracted", () => {
    expect(cellsOf(renderFindingsTable([f("source_missing")]))[0])
      .toContain("[TIDAK TERVERIFIKASI TERHADAP DOKUMEN]");
  });

  // A paraphrase came from the document, so the substance stands; only a quote
  // that is not there at all is unsafe to assert.
  it("leaves verified, paraphrased, unquotable and unchecked findings unmarked", () => {
    for (const v of ["verified", "paraphrased", "no_quote"] as const) {
      expect(cellsOf(renderFindingsTable([f(v)]))[0], v).toBe("NIB tidak ditemukan");
    }
    expect(cellsOf(renderFindingsTable([f(null)]))[0]).toBe("NIB tidak ditemukan");
  });

  it("tells the reader how many are unverified rather than leaving them to spot markers", () => {
    const blocks = renderFindingsTable([f("not_found"), f("source_missing"), f("verified")]);
    const note = blocks.find((b) => b.kind === "note");
    expect(note).toBeDefined();
    expect(JSON.stringify(note)).toContain("2 butir");
    expect(JSON.stringify(note)).toContain("wajib ditelaah");
  });

  it("adds no such note when every finding is grounded", () => {
    const blocks = renderFindingsTable([f("verified"), f("paraphrased")]);
    expect(blocks.find((b) => b.kind === "note")).toBeUndefined();
  });
});
