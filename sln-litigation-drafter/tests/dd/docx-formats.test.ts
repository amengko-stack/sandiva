import { describe, it, expect } from "vitest";
import { inflateRawSync } from "zlib";
import { buildDdReportDocx } from "@/lib/dd/dd-docx-builder";
import { verifyDocx } from "@/lib/docx-verify";
import { planChapters } from "@/config/ddChapters";
import { resolveRegime } from "@/lib/dd/regime";
import { DD_DEFAULT_REPORT_OPTIONS } from "@/types/dd";
import type {
  DDEntityResult, DDReportFormat, DDReportMeta, DDReportOptions, DDTransaction,
} from "@/types/dd";

/** Visible text of word/document.xml. */
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
        .toString("utf8").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("word/document.xml not found");
}

const meta: DDReportMeta = {
  matterRef: "SLN-1", clientName: "PT Klien", addressee: "Direksi PT Klien",
  relianceScope: "PT Klien saja", clientRelease: false, ddStartDateISO: "2026-07-01",
  taxInScope: true, assumptionsVariant: "ringkas", reportStage: "final", signatoryName: "Advokat", signatoryTitle: "Partner",
};

const txn = (over: Partial<DDTransaction> = {}): DDTransaction => ({
  id: "s1", name: "Proyek Alpha", type: "akuisisi_saham", clientRole: "pembeli",
  cutoffDateISO: "2026-07-08", checklistVersion: "seed-1", reportMeta: meta,
  entities: [{ id: "e1", name: "PT Alpha", role: "target", dataRoomPath: "x", files: [] }],
  ...over,
});

const result = (): DDEntityResult => ({
  entity: { id: "e1", name: "PT Alpha", role: "target", dataRoomPath: "x", files: [], listingStatus: "non_tbk" },
  classified: [{
    fileName: "nib.pdf", entityId: "e1", aspectId: "perizinan", expectedDocId: "perizinan.nib",
    docLabel: "NIB", docDate: "2023-01-01", parties: ["PT Alpha"], summary: "NIB",
    confidence: "tinggi", reasoning: "",
  }],
  gaps: [{
    entityId: "e1", aspectId: "perizinan", expectedDocId: "perizinan.nib", expectedLabel: "NIB",
    status: "missing", matchedFiles: [], severity: "kritis", note: "",
  }],
  rows: [],
  findings: [
    {
      id: "f1", entityId: "e1", aspectId: "perizinan", dimension: "risiko", severity: "kritis",
      anchor: "kutipan", sourceFile: "nib.pdf", problem: "NIB tidak ditemukan",
      whyItMatters: "Dampak", suggestedFix: "Mintakan NIB dari target",
      legalConsequence: "Sanksi administratif menurut PP 5/2021", regulationRefs: ["PP 5/2021"],
      verified: true, status: "open",
    },
    {
      id: "f2", entityId: "e1", aspectId: "pendirian_ad", dimension: "risiko", severity: "minor",
      anchor: "kutipan", sourceFile: "akta.pdf", problem: "Ejaan nama berbeda",
      whyItMatters: "Dampak", suggestedFix: "Mintakan akta perubahan nama",
      verified: false, status: "open",
    },
  ],
  extractReport: null,
  analyses: [],
});

const build = async (
  format: DDReportFormat | undefined,
  over: { options?: Partial<DDReportOptions>; clientRole?: string } = {}
) => {
  const t = txn({
    reportFormat: format,
    clientRole: over.clientRole ?? "pembeli",
    reportOptions: over.options ? { ...DD_DEFAULT_REPORT_OPTIONS, ...over.options } : undefined,
  });
  const buf = await buildDdReportDocx({ transaction: t, results: [result()], consolidated: null });
  expect(verifyDocx(buf).bad, format ?? "default").toBe(0);
  expect(verifyDocx(buf).illegal, format ?? "default").toBe(0);
  return docxText(buf);
};

const FORMATS: DDReportFormat[] = ["pendahuluan_led", "exec_summary_led", "lut_pasar_modal", "findings_only"];

describe("every format actually renders", () => {
  // The bug being guarded: planChapters returns chapters the builder does not
  // recognise, and they vanish silently — so a format "works" while producing a
  // document missing most of itself.
  it("emits every planned chapter title into the document", async () => {
    for (const format of FORMATS) {
      const text = await build(format);
      const planned = planChapters({
        transactionType: "akuisisi_saham",
        regime: resolveRegime({ id: "e1", name: "PT Alpha", role: "target", dataRoomPath: "x", files: [], listingStatus: "non_tbk" }),
        presentAspects: ["perizinan", "pendirian_ad"],
        format,
        clientRole: "pembeli",
      });
      for (const ch of planned) {
        // Titles may have their English gloss stripped, so compare on the
        // Indonesian part only.
        const indo = ch.title.replace(/\s*\([A-Z][^)]*\)$/, "");
        expect(text, `${format} :: ${ch.title}`).toContain(indo);
      }
    }
  });

  it("produces a substantial document for each format, not a husk", async () => {
    for (const format of FORMATS) {
      const text = await build(format);
      expect(text.length, format).toBeGreaterThan(4000);
      expect(text, format).toContain("LAPORAN UJI TUNTAS DARI SEGI HUKUM");
      expect(text, format).toContain("DISCLAIMER");
    }
  });

  it("never prints a severity label or risk rating by default", async () => {
    for (const format of FORMATS) {
      const text = await build(format);
      expect(text, format).not.toMatch(/\[KRITIS\]|\[MATERIAL\]|\[MINOR\]/);
      expect(text, format).not.toMatch(/Tingkat Risiko/);
      expect(text, format).not.toMatch(/\[T\]|\[S\]|\[R\]/);
    }
  });
});

describe("format-specific content", () => {
  it("exec_summary_led opens with the executive summary and omits Pendahuluan", async () => {
    const text = await build("exec_summary_led");
    expect(text).toContain("RINGKASAN EKSEKUTIF");
    expect(text).toContain("INFORMASI KORPORASI");
    expect(text).not.toContain("BAB I — PENDAHULUAN");
  });

  it("findings_only carries recommendations and no profile chapter", async () => {
    const text = await build("findings_only");
    expect(text).toContain("RINGKASAN EKSEKUTIF");
    expect(text).toContain("REKOMENDASI DAN TINDAK LANJUT");
    expect(text).toContain("Mintakan NIB dari target");
    expect(text).not.toContain("PROFIL PERSEROAN");
  });

  it("lut_pasar_modal carries both the UUPT transaction block and the capital-markets chapter", async () => {
    const text = await build("lut_pasar_modal");
    expect(text).toContain("KEPATUHAN KETENTUAN PASAR MODAL");
    // A Tbk is bound by UUPT too; omitting this was a real defect.
    expect(text).toContain("Pasal 127 ayat (2) UUPT");
  });

  it("renders the sell-side chapters when acting for the seller", async () => {
    const text = await build("exec_summary_led", { clientRole: "penjual" });
    expect(text).toContain("KESIAPAN DATA ROOM");
    expect(text).toContain("ISU YANG PERLU DIUNGKAPKAN KEPADA PEMBELI");
    expect(text).toContain("KEWAJIBAN PENJUAL PASCA-CLOSING");
  });
});

describe("report options reach the document", () => {
  it("strips the English gloss unless bilingual headings are on", async () => {
    const plain = await build("exec_summary_led");
    const bilingual = await build("exec_summary_led", { options: { bilingualHeadings: true } });
    expect(plain).not.toContain("(CORPORATE INFORMATION)");
    expect(bilingual).toContain("CORPORATE INFORMATION");
    // The Indonesian title survives either way.
    expect(plain).toContain("INFORMASI KORPORASI");
    expect(bilingual).toContain("INFORMASI KORPORASI");
  });

  it("shows the risk column in either notation when asked", async () => {
    const kata = await build("pendahuluan_led", { options: { riskColumn: "kata" } });
    expect(kata).toContain("Tingkat Risiko");
    expect(kata).toContain("Tinggi");

    const kode = await build("pendahuluan_led", { options: { riskColumn: "kode" } });
    expect(kode).toContain("Tinggi [T]");
  });

  it("adds Tim Pemeriksa without dropping Asumsi dan Pembatasan", async () => {
    const text = await build("pendahuluan_led", { options: { includeTimPemeriksa: true } });
    expect(text).toContain("Tim Pemeriksa");
    // The standard requires the assumptions and qualifications regardless.
    expect(text).toContain("Asumsi dan Pembatasan");
  });
});

describe("backward compatibility", () => {
  it("omitting reportFormat reproduces the pendahuluan_led document", async () => {
    const [a, b] = [await build(undefined), await build("pendahuluan_led")];
    expect(a).toBe(b);
  });

  it("still refuses a client release with no reliance scope", async () => {
    const t = txn({
      reportFormat: "exec_summary_led",
      reportMeta: { ...meta, clientRelease: true, relianceScope: "" },
    });
    await expect(
      buildDdReportDocx({ transaction: t, results: [result()], consolidated: null })
    ).rejects.toThrow(/Ruang Lingkup Keterandalan/);
  });
});
