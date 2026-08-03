import { describe, it, expect } from "vitest";
import { inflateRawSync } from "zlib";
import { buildDdReportDocx } from "@/lib/dd/dd-docx-builder";
import { verifyDocx } from "@/lib/docx-verify";
import type { DDConsolidated, DDEntityResult, DDReportMeta, DDTransaction } from "@/types/dd";

/** Visible text of word/document.xml, so assertions can read the rendered report. */
function docxText(buf: Buffer): string {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const compSize = buf.readUInt32LE(off + 20);
    if (buf.toString("utf8", off + 46, off + 46 + nameLen) === "word/document.xml") {
      const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      return inflateRawSync(buf.subarray(start, start + compSize))
        .toString("utf8")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("word/document.xml not found");
}

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

  it("builds cleanly when all cross-entity findings are dismissed (empty-state fallback path)", async () => {
    const allDismissed: DDConsolidated = {
      ...consolidated,
      crossEntityFindings: [{
        id: "consolidated-konsistensi-0", entityId: "consolidated", aspectId: "perizinan", dimension: "konsistensi", severity: "material",
        anchor: "kutipan", sourceFile: "nib.pdf", problem: "Masalah lintas-entitas", whyItMatters: "Dampak", suggestedFix: "Fix",
        verified: false, status: "dismissed",
      }],
    };
    const buf = await buildDdReportDocx({
      transaction, results: [result("e1", "PT Alpha")], consolidated: allDismissed,
    });
    const verdict = verifyDocx(buf);
    expect(verdict.bad).toBe(0);
    expect(verdict.illegal).toBe(0);
    expect(buf.length).toBeGreaterThan(5000);
  });
});

// The listing-status axis is the point of the LUT rewrite: what binds a PT Tbk
// does not automatically bind a PT Tertutup, and a private company under a Tbk
// parent shifts the obligations to the parent rather than acquiring them itself.
describe("buildDdReportDocx — listing-status regime", () => {
  const build = async (entityPatch: Partial<DDEntityResult["entity"]>) => {
    const r = result("e1", "PT Alpha");
    const results = [{ ...r, entity: { ...r.entity, ...entityPatch } }];
    const buf = await buildDdReportDocx({ transaction, results, consolidated: null });
    expect(verifyDocx(buf).bad).toBe(0);
    expect(verifyDocx(buf).illegal).toBe(0);
    return docxText(buf);
  };

  it("applies the UUPT baseline and section VII.A at every status", async () => {
    for (const patch of [
      { listingStatus: "non_tbk" as const },
      { listingStatus: "non_tbk" as const, ultimateParentTbk: "PT Induk Tbk" },
      { listingStatus: "tbk" as const },
    ]) {
      const text = await build(patch);
      expect(text).toContain("LAPORAN UJI TUNTAS DARI SEGI HUKUM");
      expect(text).toContain("VII.A");
      expect(text).toContain("Pasal 127 ayat (2) UUPT");
      expect(text).toContain("Kesimpulan keseluruhan");
    }
  });

  it("omits the capital-markets section for a plain private company", async () => {
    const text = await build({ listingStatus: "non_tbk" });
    expect(text).not.toContain("VII.B");
    // Citing rules that do not bind the company would be a material defect.
    expect(text).not.toContain("POJK 17");
    expect(text).not.toContain("Penawaran Tender Wajib");
  });

  it("places obligations at the parent for a private company with a Tbk parent", async () => {
    const text = await build({ listingStatus: "non_tbk", ultimateParentTbk: "PT Induk Tbk" });
    expect(text).toContain("VII.B");
    expect(text).toContain("PT Induk Tbk");
    expect(text).toContain("perusahaan terkendali");
    expect(text).toContain("Pengujian Ambang Transaksi Material terhadap Induk");
    // Financial figures are outside legal-DD scope, so the ratios stay flagged.
    expect(text).toContain("PERLU VERIFIKASI");
    // The private subsidiary is not itself a tender-offer subject.
    expect(text).not.toContain("Penawaran Tender Wajib");
  });

  it("applies the direct capital-markets regime when the entity is itself Tbk", async () => {
    const text = await build({ listingStatus: "tbk" });
    expect(text).toContain("VII.B");
    expect(text).toContain("POJK 9/POJK.04/2018");
    expect(text).toContain("Penawaran Tender Wajib");
    // Thresholds are measured against the entity, not a parent.
    expect(text).not.toContain("Pengujian Ambang Transaksi Material terhadap Induk");
  });

  it("adds the BUMN section only as open questions", async () => {
    const text = await build({ listingStatus: "non_tbk", isBumn: true });
    expect(text).toContain("VII.C");
    expect(text).toContain("PERTANYAAN WAJIB");
    expect(text).toContain("belum diverifikasi");
  });
});

describe("buildDdReportDocx — client-release gate", () => {
  const meta: DDReportMeta = {
    matterRef: "SLN-LDD-2026-001",
    clientName: "PT Klien",
    addressee: "Direksi PT Klien",
    relianceScope: "",
    clientRelease: true,
    ddStartDateISO: "2026-07-01",
    taxInScope: false,
    assumptionsVariant: "ringkas",
    signatoryName: "Advokat",
    signatoryTitle: "Partner",
  };

  it("refuses a client release with no reliance scope, and allows it once set", async () => {
    const results = [result("e1", "PT Alpha")];
    await expect(
      buildDdReportDocx({ transaction: { ...transaction, reportMeta: meta }, results, consolidated: null })
    ).rejects.toThrow(/Ruang Lingkup Keterandalan/);

    const buf = await buildDdReportDocx({
      transaction: { ...transaction, reportMeta: { ...meta, relianceScope: "PT Klien saja" } },
      results,
      consolidated: null,
    });
    expect(verifyDocx(buf).bad).toBe(0);
    expect(docxText(buf)).toContain("PT Klien saja");
  });

  it("marks an unreleased report as a draft", async () => {
    const buf = await buildDdReportDocx({
      transaction: { ...transaction, reportMeta: { ...meta, clientRelease: false, relianceScope: "PT Klien saja" } },
      results: [result("e1", "PT Alpha")],
      consolidated: null,
    });
    expect(docxText(buf)).toContain("DRAF — TIDAK UNTUK DIEDARKAN");
  });
});
