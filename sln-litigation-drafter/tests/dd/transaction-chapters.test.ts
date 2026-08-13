import { describe, it, expect } from "vitest";
import { inflateRawSync } from "zlib";
import { transactionAnalysisSystem } from "@/lib/dd/prompts";
import { buildDdReportDocx } from "@/lib/dd/dd-docx-builder";
import type {
  DDEntityResult, DDReportMeta, DDSubsectionAnalysis, DDTransaction,
} from "@/types/dd";

// A live dissolution report came out with all twelve of its transaction sub-sections
// holding one generated sentence each — "Bagian ini menguraikan pemenuhan ketentuan
// ... terkait analisis solvabilitas" — while the nine aspect chapters were full. The
// chapters most specific to the transaction were the only empty ones, in a report
// about that transaction.
//
// Two causes. Nothing ever produced the analysis: Stage 5 requests sub-section
// analysis per aspect, and a transaction chapter maps to no aspect. And the renderer
// never looked for one.

const meta: DDReportMeta = {
  matterRef: "50160", clientName: "PT Klien", addressee: "Direksi",
  relianceScope: "PT Klien", clientRelease: false, ddStartDateISO: "2026-07-01",
  taxInScope: true, assumptionsVariant: "ringkas", reportStage: "interim",
  signatoryName: "Advokat", signatoryTitle: "Partner",
};

const transaction = {
  id: "t1", name: "Pembubaran PT Target", type: "likuidasi", entities: [],
  cutoffDateISO: "2026-08-12", clientRole: "pemegang saham", reportMeta: meta,
} as unknown as DDTransaction;

const result = (analyses: DDSubsectionAnalysis[]): DDEntityResult =>
  ({
    entity: { id: "e1", name: "PT Target", role: "target", dataRoomPath: "", files: [], listingStatus: "non_tbk" },
    classified: [{
      fileName: "rups.pdf", entityId: "e1", aspectId: "pendirian_ad", expectedDocId: null,
      docLabel: "Akta RUPS Pembubaran", docDate: "2026-03-03", parties: [],
      summary: "Keputusan pemegang saham untuk membubarkan Perseroan.",
      confidence: "tinggi", reasoning: "",
    }],
    gaps: [], rows: [], findings: [], extractReport: null, narrative: null, analyses,
  }) as unknown as DDEntityResult;

/** Visible text of word/document.xml (same reader as docx-formats.test.ts). */
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

const build = async (analyses: DDSubsectionAnalysis[]) =>
  docxText(await buildDdReportDocx({ transaction, results: [result(analyses)], consolidated: null }));

describe("transaction chapters carry their analysis", () => {
  const analysis: DDSubsectionAnalysis = {
    aspectId: "transaksi",
    subsectionTitle: "Dasar Hukum Pembubaran",
    analysis: [
      "Akta No. 12 tanggal 3 Maret 2026 memuat keputusan pemegang saham untuk membubarkan Perseroan.",
      "Dasar hukumnya adalah UUPT Pasal 142 ayat (1) huruf a.",
    ],
    verification: ["Risalah RUPS pembubaran belum tersedia dalam data room."],
  };

  it("prints the analysis instead of a scaffolding sentence", async () => {
    const text = await build([analysis]);
    expect(text).toContain("Akta No. 12 tanggal 3 Maret 2026");
    expect(text).toContain("Pasal 142 ayat (1) huruf a");
    expect(text).not.toContain("Bagian ini menguraikan pemenuhan ketentuan");
  });

  it("prints what still needs verifying", async () => {
    expect(await build([analysis])).toContain("Risalah RUPS pembubaran belum tersedia");
  });

  // The old fallback read like an introduction to content that was not there, which
  // a reader takes for a summary. An admission is safer than a description.
  it("marks an unanalysed sub-section rather than describing it", async () => {
    const text = await build([]);
    expect(text).toContain("[BELUM DIANALISIS]");
    expect(text).toContain("BUKAN pernyataan bahwa");
    expect(text).not.toContain("Bagian ini menguraikan pemenuhan ketentuan");
  });

  it("keeps the UUPT obligation table either way", async () => {
    for (const a of [[analysis], []]) {
      expect(await build(a)).toContain("Kewajiban yang relevan berdasarkan Undang-Undang");
    }
  });
});

describe("transactionAnalysisSystem", () => {
  it("asks for what is present and, explicitly, for what is missing", () => {
    const p = transactionAnalysisSystem();
    expect(p).toContain("SUDAH ada");
    expect(p).toContain("BELUM ada");
    // The absence of a required step is the substance here, not a gap to skip.
    expect(p).toContain("paling penting");
  });

  // The defect it exists to prevent, stated in the prompt itself.
  it("forbids the introductory sentence that produced the empty chapters", () => {
    expect(transactionAnalysisSystem()).toContain("JANGAN menuliskan kalimat pengantar");
  });

  it("carries the verbatim-quote rule and the money rule", () => {
    const p = transactionAnalysisSystem();
    expect(p).toContain("DISALIN KARAKTER DEMI KARAKTER");
    expect(p).toContain("ANGKA DAN NILAI UANG");
  });
});
