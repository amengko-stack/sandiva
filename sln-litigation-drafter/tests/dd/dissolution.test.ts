import { describe, it, expect } from "vitest";
import { planChapters } from "@/config/ddChapters";
import { financialFigureQualification, solvencyUndeterminedNote } from "@/lib/dd/report-boilerplate";
import { redflagSystem } from "@/lib/dd/prompts";
import type { DDAspectId, DDRegime } from "@/types/dd";

// The dissolution chapters exist because UUPT requires the analysis: Pasal 149
// makes inventorying assets and liabilities the liquidator's first duty, Pasal 150
// fixes the payment order, and whether the estate covers the claims decides whether
// Pasal 142 applies at all or the matter belongs in insolvency.
//
// The gap was noticed while comparing against an instruction file in the client's
// folders, which was cited at the time as the firm's written specification. It is
// Claude output, like the LDD reports beside it — so it is not authority for
// anything. The statute is, and these chapters answer to it.

const regime = { layers: ["uupt"], capitalMarkets: false, parentTbkName: null } as unknown as DDRegime;
const ALL: DDAspectId[] = [
  "pendirian_ad", "permodalan_saham", "pengurus", "perizinan", "harta_kekayaan",
  "perjanjian_penting", "ketenagakerjaan", "perpajakan", "asuransi", "perkara",
];

const plan = (type: "likuidasi" | "akuisisi_saham") =>
  planChapters({ transactionType: type, regime, presentAspects: ALL });

const titles = (type: "likuidasi" | "akuisisi_saham") => plan(type).map((c) => c.title);
const subsOf = (type: "likuidasi" | "akuisisi_saham", title: string) =>
  (plan(type).find((c) => c.title === title)?.subs ?? []).map((s) => s.title);

describe("dissolution chapters against the firm's written instruction", () => {
  it("keeps the three chapters that already matched the instruction", () => {
    expect(subsOf("likuidasi", "DASAR DAN ALASAN PEMBUBARAN")).toEqual([
      "Dasar Hukum Pembubaran", "Alasan Pembubaran", "Keabsahan Keputusan RUPS Pembubaran",
    ]);
    expect(subsOf("likuidasi", "ANALISIS LIKUIDATOR")).toEqual([
      "Pengangkatan Likuidator", "Kewajiban dan Wewenang Likuidator", "Urutan Pembayaran dalam Likuidasi",
    ]);
    expect(subsOf("likuidasi", "KEWAJIBAN YANG HARUS DISELESAIKAN")).toContain("Kewajiban kepada Kreditor");
  });

  // BAB XI. Not an appendix to a liquidation report: whether the estate covers the
  // claims decides whether UUPT Pasal 142 applies at all, or the matter belongs in
  // insolvency.
  it("has the asset and solvency chapter the instruction requires", () => {
    expect(titles("likuidasi")).toContain("ANALISIS ASET YANG AKAN DILIKUIDASI");
    expect(subsOf("likuidasi", "ANALISIS ASET YANG AKAN DILIKUIDASI")).toEqual([
      "Inventarisasi Aset untuk Dilikuidasi", "Analisis Solvabilitas", "Aset Bermasalah",
    ]);
  });

  it("places it before the procedural chapter, as the instruction numbers it", () => {
    const t = titles("likuidasi");
    expect(t.indexOf("ANALISIS ASET YANG AKAN DILIKUIDASI")).toBeGreaterThan(
      t.indexOf("KEWAJIBAN YANG HARUS DISELESAIKAN")
    );
    expect(t.indexOf("ANALISIS ASET YANG AKAN DILIKUIDASI")).toBeLessThan(
      t.indexOf("PROSES PEMBUBARAN DAN LIKUIDASI")
    );
  });

  it("carries the liquidation cost components (12.3)", () => {
    expect(subsOf("likuidasi", "PROSES PEMBUBARAN DAN LIKUIDASI")).toContain("Komponen Biaya Likuidasi");
  });

  // 13.2, and it sits right after the summary because it is the sentence a
  // shareholder reads first.
  it("adds the final solvency assessment to the conclusion, second", () => {
    const subs = subsOf("likuidasi", "KESIMPULAN DAN REKOMENDASI");
    expect(subs[1]).toBe("Analisis Solvabilitas Final");
    expect(subs[0]).toBe("Ringkasan Temuan");
  });

  it("adds none of this to a transaction that is not a dissolution", () => {
    const t = titles("akuisisi_saham");
    expect(t).not.toContain("ANALISIS ASET YANG AKAN DILIKUIDASI");
    expect(subsOf("akuisisi_saham", "KESIMPULAN DAN REKOMENDASI")).not.toContain("Analisis Solvabilitas Final");
  });
});

// The report says in its own qualifications that the examination does not cover the
// truth of financial data, and valuation is outside a lawyer's competence. The
// firm's instruction resolves it: figures are estimates requiring an accountant.
describe("money in a legal report", () => {
  it("states that figures are copied, are estimates, and need an accountant", () => {
    const q = financialFigureQualification();
    expect(q).toContain("dikutip dari dokumen");
    expect(q).toContain("WAJIB diverifikasi oleh akuntan");
    expect(q).toContain("tidak melakukan valuasi");
    expect(q).toContain("tidak menghitung");
  });

  // Silence would read as though the estate is adequate. The absence has to be
  // stated as an absence, with the legal consequence attached.
  it("says plainly when solvency cannot be determined, and what turns on it", () => {
    const n = solvencyUndeterminedNote();
    expect(n).toContain("tidak memuat data yang cukup");
    expect(n).toContain("kepailitan");
    expect(n).toContain("Pasal 150");
    expect(n).toContain("[PERLU VERIFIKASI]");
  });

  it("forbids the model from computing or estimating any figure", () => {
    const p = redflagSystem();
    expect(p).toContain("ANGKA DAN NILAI UANG");
    expect(p).toContain("JANGAN menjumlahkan");
    expect(p).toContain("itu hitunganmu");
    expect(p).toContain("tidak ada dokumen yang menyatakannya");
    // Solvency stated as a legal consequence, not a financial opinion.
    expect(p).toContain("BUKAN sebagai penilaian keuangan");
  });
});
