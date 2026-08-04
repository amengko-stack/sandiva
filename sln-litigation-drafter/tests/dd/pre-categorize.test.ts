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
