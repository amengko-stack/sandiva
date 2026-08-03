import { describe, it, expect } from "vitest";
import { renderFindingsTable, renderVerdictLine } from "@/lib/dd/findings-render";
import type { DDFinding } from "@/types/dd";

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
