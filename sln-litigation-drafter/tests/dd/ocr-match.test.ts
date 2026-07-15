import { describe, it, expect } from "vitest";
import { matchOcrFiles } from "@/lib/dd/ocr-match";

describe("matchOcrFiles", () => {
  it("matches an OCR file to a perlu_ocr name via exact filename match", () => {
    const result = matchOcrFiles(
      [{ name: "Akta Pendirian.pdf", path: "/ocr/Akta Pendirian.pdf" }],
      ["Akta Pendirian.pdf", "Lain.pdf"]
    );
    expect(result).toEqual([
      { name: "Akta Pendirian.pdf", path: "/ocr/Akta Pendirian.pdf", replacesName: "Akta Pendirian.pdf" },
    ]);
  });

  it("falls back to a case-insensitive base-name match when extension/case differ", () => {
    const result = matchOcrFiles(
      [{ name: "akta pendirian.PDF", path: "/ocr/akta pendirian.PDF" }],
      ["Akta Pendirian.pdf"]
    );
    expect(result[0].replacesName).toBe("Akta Pendirian.pdf");
  });

  it("tolerates common OCR-suffix patterns (_ocr, -ocr, (OCR))", () => {
    const result = matchOcrFiles(
      [
        { name: "Akta_ocr.pdf", path: "/a" },
        { name: "Perjanjian-OCR.pdf", path: "/b" },
        { name: "Invoice (OCR).pdf", path: "/c" },
      ],
      ["Akta.pdf", "Perjanjian.pdf", "Invoice.pdf"]
    );
    expect(result[0].replacesName).toBe("Akta.pdf");
    expect(result[1].replacesName).toBe("Perjanjian.pdf");
    expect(result[2].replacesName).toBe("Invoice.pdf");
  });

  it("leaves an OCR file unmatched (replacesName undefined) when no perlu_ocr name corresponds", () => {
    const result = matchOcrFiles(
      [{ name: "Dokumen Baru.pdf", path: "/ocr/Dokumen Baru.pdf" }],
      ["Akta.pdf"]
    );
    expect(result).toEqual([
      { name: "Dokumen Baru.pdf", path: "/ocr/Dokumen Baru.pdf", replacesName: undefined },
    ]);
  });

  it("claims each perlu_ocr name at most once — the first matching OCR file wins", () => {
    const result = matchOcrFiles(
      [
        { name: "Akta.pdf", path: "/exact" },
        { name: "Akta_ocr.pdf", path: "/suffix" },
      ],
      ["Akta.pdf"]
    );
    expect(result[0].replacesName).toBe("Akta.pdf");
    expect(result[1].replacesName).toBeUndefined();
  });

  it("matches multiple distinct pairs independently without cross-claiming", () => {
    const result = matchOcrFiles(
      [
        { name: "Beta_ocr.pdf", path: "/beta" },
        { name: "Alpha.pdf", path: "/alpha" },
      ],
      ["Alpha.pdf", "Beta.pdf"]
    );
    expect(result.find((r) => r.name === "Alpha.pdf")?.replacesName).toBe("Alpha.pdf");
    expect(result.find((r) => r.name === "Beta_ocr.pdf")?.replacesName).toBe("Beta.pdf");
  });
});
