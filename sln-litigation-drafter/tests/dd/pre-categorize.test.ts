import { describe, it, expect } from "vitest";
import { preCategorize } from "@/lib/dd/pre-categorize";

describe("preCategorize", () => {
  it("routes agreements, deeds, licenses, and financials to KRITIS", () => {
    for (const name of [
      "Perjanjian Kredit BCA 2023.pdf", "PKS Distribusi.docx", "Akta Pendirian No 12.pdf",
      "NIB PT Alpha.pdf", "Sertifikat HGB 456.pdf", "SPT Tahunan 2024.pdf",
      "Loan Agreement (amended).pdf", "Anggaran Dasar 2022.docx", "Polis Asuransi Kebakaran.pdf",
    ]) {
      expect(preCategorize(name), name).toBe("KRITIS");
    }
  });
  it("routes everything else to PENDUKUNG (never REFERENSI — DD reads everything)", () => {
    expect(preCategorize("Surat menyurat internal.docx")).toBe("PENDUKUNG");
    expect(preCategorize("foto kantor.pdf")).toBe("PENDUKUNG");
  });
});

// The keyword list had no term for a financial statement. On a live dissolution the
// six audited accounts were named "2021 FS PT SBI Bangun Nusantara_Dec. 31, 2021.pdf"
// and "PT SBI Bangun Nusantara - 31 Desember 2023 (FINAL).pdf", matched nothing, fell
// to the lower extraction tier and were cut at 30,000 characters — while the tax
// return came through whole because its name contains "spt". The notes to a financial
// statement are at the end: contingent liabilities, related parties, going concern.
describe("financial statements reach the full tier", () => {
  const names = [
    "2021 FS PT SBI Bangun Nusantara_Dec. 31, 2021.pdf",
    "FS PT SBI Bangun Nusantara - 31 December 2025.pdf",
    "PT SBI Bangun Nusantara - 31 Desember 2023 (FINAL).pdf",
    "2022 PT SBI Bangun Nusantara - 31 Desember 2022 (FINAL).pdf",
    "Laporan Keuangan Auditan 2024.pdf",
    "LK PT Alpha 2023.pdf",
  ];

  it("categorises every financial statement from the live matter as KRITIS", () => {
    for (const n of names) expect(preCategorize(n), n).toBe("KRITIS");
  });

  it("still sends an ordinary supporting document to the lower tier", () => {
    for (const n of ["Struktur Organisasi.pdf", "Daftar Karyawan.pdf", "BAST Pekerjaan.pdf"]) {
      expect(preCategorize(n), n).toBe("PENDUKUNG");
    }
  });
});
