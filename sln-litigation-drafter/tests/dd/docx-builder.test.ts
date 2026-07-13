import { describe, it, expect } from "vitest";
import { buildDdReportDocx } from "@/lib/dd/dd-docx-builder";
import { verifyDocx } from "@/lib/docx-verify";
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

describe("buildDdReportDocx", () => {
  it("produces a structurally valid docx (verifyDocx clean)", async () => {
    const buf = await buildDdReportDocx({
      transaction, results: [result("e1", "PT Alpha"), result("e2", "PT Beta")], consolidated,
    });
    const verdict = verifyDocx(buf);
    expect(verdict.bad).toBe(0);
    expect(verdict.illegal).toBe(0);
    expect(buf.length).toBeGreaterThan(5000);
  });

  it("strips XML-illegal characters from content", async () => {
    const dirty = result("e1", "PT Alpha");
    dirty.findings[0].problem = "Masalah dengan" + String.fromCharCode(7) + "karakter kontrol"; // BEL control char
    const buf = await buildDdReportDocx({ transaction, results: [dirty], consolidated: null });
    expect(verifyDocx(buf).illegal).toBe(0);
  });
});
