import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildDdWorkbook } from "@/lib/dd/dd-excel-builder";
import type { DDConsolidated, DDEntityResult, DDTransaction } from "@/types/dd";

const transaction: DDTransaction = {
  id: "s1", name: "Proyek Alpha", type: "akuisisi_saham", clientRole: "pembeli",
  cutoffDateISO: "2026-07-08", checklistVersion: "seed-1",
  entities: [
    { id: "e1", name: "PT Alpha", role: "target", dataRoomPath: "x", files: [] },
    { id: "e2", name: "PT Beta", role: "target", dataRoomPath: "y", files: [] },
  ],
};

const result = (eid: string, name: string): DDEntityResult => ({
  entity: { id: eid, name, role: "target", dataRoomPath: "x", files: [] },
  classified: [{
    fileName: "nib.pdf", entityId: eid, aspectId: "perizinan", expectedDocId: "perizinan.nib",
    docLabel: "NIB", docDate: "2023-01-01", parties: [name], summary: "NIB perusahaan",
    confidence: "tinggi", reasoning: "",
  }],
  gaps: [{
    entityId: eid, aspectId: "perizinan", expectedDocId: "perizinan.nib", expectedLabel: "NIB",
    status: eid === "e1" ? "present" : "missing", matchedFiles: eid === "e1" ? ["nib.pdf"] : [],
    severity: "kritis", note: "",
  }],
  rows: [{
    groupId: `${eid}-grp-0`, entityId: eid, agreementLabel: "PK BCA", memberFiles: ["pk.pdf"],
    status: "selesai",
    cells: [{ fieldId: "change_of_control", type: "verbatim", value: "perlu persetujuan", verbatim: "Debitur wajib...", sourceFile: "pk.pdf", dealTriggered: true }],
  }],
  findings: [{
    id: `${eid}-risiko-0`, entityId: eid, aspectId: "perizinan", dimension: "risiko", severity: "kritis",
    anchor: "kutipan", sourceFile: "nib.pdf", problem: "Masalah", whyItMatters: "Dampak", suggestedFix: "Fix",
    verified: true, status: "open",
  }],
  extractReport: null,
});

const consolidated: DDConsolidated = {
  transactionType: "akuisisi_saham",
  crossEntityFindings: [],
  aspectRollup: [{ aspectId: "perizinan", totalExpected: 2, present: 1, missing: 1, incomplete: 0, expired: 0, notApplicable: 0 }],
  generatedAt: "2026-07-08T00:00:00.000Z",
};

describe("buildDdWorkbook", () => {
  it("produces the five sheets with per-entity gap columns", async () => {
    const buf = await buildDdWorkbook({ transaction, results: [result("e1", "PT Alpha"), result("e2", "PT Beta")], consolidated });
    const wb = new ExcelJS.Workbook();
    // exceljs Buffer type quirk (see Task 5)
    await wb.xlsx.load(buf as any);
    for (const name of ["Indeks Dokumen", "Matriks Gap", "Ketentuan Kunci", "Temuan", "Ringkasan"]) {
      expect(wb.getWorksheet(name), name).toBeTruthy();
    }
    const gap = wb.getWorksheet("Matriks Gap")!;
    const header = gap.getRow(1).values as unknown[];
    expect(header).toContain("PT Alpha");
    expect(header).toContain("PT Beta");
    // e1 has NIB, e2 missing
    const row2 = gap.getRow(2).values as unknown[];
    expect(JSON.stringify(row2)).toContain("Ada");
    expect(JSON.stringify(row2)).toContain("TIDAK ADA");
    const temuan = wb.getWorksheet("Temuan")!;
    expect(temuan.rowCount).toBeGreaterThanOrEqual(3); // header + 2 findings
  });
});
