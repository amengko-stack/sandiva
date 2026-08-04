import { describe, it, expect } from "vitest";
import { mergeExtractReports } from "@/lib/dd/merge-report";
import type { ExtractReport } from "@/types";

// Small fixture builder — only the fields each test cares about vary.
function report(overrides: Partial<ExtractReport> = {}): ExtractReport {
  return {
    sessionId: "sess1234",
    folderPath: "",
    docTypeId: "dd",
    practiceAreaId: null,
    claimType: null,
    ref: "pt-alpha",
    timestamp: "2026-01-01T00:00:00.000Z",
    files: [],
    totalChars: 0,
    processed: 0,
    skipped: 0,
    cacheHits: 0,
    ocrRequired: 0,
    ...overrides,
  };
}

describe("mergeExtractReports", () => {
  it("appends disjoint filenames and recomputes counters", () => {
    const existing = report({
      files: [
        { name: "a.pdf", category: "KRITIS", documentType: "tidak_dikenali", extractionMode: "Teks penuh", status: "selesai", charCount: 100 },
      ],
      totalChars: 100,
      processed: 1,
      skipped: 0,
      ocrRequired: 0,
    });
    const current = report({
      files: [
        { name: "b.pdf", category: "PENDUKUNG", documentType: "tidak_dikenali", extractionMode: "Teks penuh", status: "selesai", charCount: 200 },
      ],
      totalChars: 200,
      processed: 1,
      skipped: 0,
      ocrRequired: 0,
    });

    const merged = mergeExtractReports(existing, current);

    expect(merged.files.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(merged.processed).toBe(2);
    expect(merged.skipped).toBe(0);
    expect(merged.ocrRequired).toBe(0);
    expect(merged.totalChars).toBe(300);
  });

  it("replaces a same-name entry (gagal -> selesai) with no duplicate and correct counters", () => {
    const existing = report({
      files: [
        { name: "a.pdf", category: "KRITIS", documentType: "tidak_dikenali", extractionMode: "—", status: "gagal", reason: "kosong" },
        { name: "b.pdf", category: "PENDUKUNG", documentType: "tidak_dikenali", extractionMode: "Teks penuh", status: "selesai", charCount: 50 },
      ],
      totalChars: 50,
      processed: 1,
      skipped: 1,
      ocrRequired: 0,
    });
    const current = report({
      files: [
        { name: "a.pdf", category: "KRITIS", documentType: "tidak_dikenali", extractionMode: "Teks penuh", status: "selesai", charCount: 120 },
      ],
      totalChars: 120,
      processed: 1,
      skipped: 0,
      ocrRequired: 0,
    });

    const merged = mergeExtractReports(existing, current);

    expect(merged.files.map((f) => f.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(merged.files.find((f) => f.name === "a.pdf")?.status).toBe("selesai");
    expect(merged.processed).toBe(2);
    expect(merged.skipped).toBe(0);
    expect(merged.totalChars).toBe(170);
  });

  it("replaces perlu_ocr -> selesai and decrements ocrRequired via recompute", () => {
    const existing = report({
      files: [
        { name: "scan.pdf", category: "KRITIS", documentType: "tidak_dikenali", extractionMode: "Perlu OCR", status: "perlu_ocr" },
      ],
      totalChars: 0,
      processed: 0,
      skipped: 0,
      ocrRequired: 1,
    });
    const current = report({
      files: [
        { name: "scan.pdf", category: "KRITIS", documentType: "tidak_dikenali", extractionMode: "Teks penuh", status: "selesai", charCount: 500 },
      ],
      totalChars: 500,
      processed: 1,
      skipped: 0,
      ocrRequired: 0,
    });

    const merged = mergeExtractReports(existing, current);

    expect(merged.files).toHaveLength(1);
    expect(merged.files[0].status).toBe("selesai");
    expect(merged.ocrRequired).toBe(0);
    expect(merged.processed).toBe(1);
    expect(merged.totalChars).toBe(500);
  });

  it("sums totalChars from charCount, treating missing charCount as 0", () => {
    const existing = report({
      files: [
        { name: "a.pdf", category: "KRITIS", documentType: "tidak_dikenali", extractionMode: "—", status: "gagal", reason: "kosong" },
      ],
      totalChars: 0,
      processed: 0,
      skipped: 1,
      ocrRequired: 0,
    });
    const current = report({
      files: [
        { name: "b.pdf", category: "PENDUKUNG", documentType: "tidak_dikenali", extractionMode: "Perlu OCR", status: "perlu_ocr" },
        { name: "c.pdf", category: "PENDUKUNG", documentType: "tidak_dikenali", extractionMode: "Teks penuh", status: "selesai", charCount: 75 },
      ],
      totalChars: 75,
      processed: 1,
      skipped: 0,
      ocrRequired: 1,
    });

    const merged = mergeExtractReports(existing, current);

    expect(merged.totalChars).toBe(75);
    expect(merged.processed).toBe(1);
    expect(merged.skipped).toBe(1);
    expect(merged.ocrRequired).toBe(1);
  });

  it("takes metadata fields from current and sums cacheHits additively", () => {
    const existing = report({ cacheHits: 2, timestamp: "2026-01-01T00:00:00.000Z", ref: "pt-alpha" });
    const current = report({ cacheHits: 3, timestamp: "2026-02-02T00:00:00.000Z", ref: "pt-alpha", sessionId: "sess9999" });

    const merged = mergeExtractReports(existing, current);

    expect(merged.cacheHits).toBe(5);
    expect(merged.timestamp).toBe("2026-02-02T00:00:00.000Z");
    expect(merged.sessionId).toBe("sess9999");
  });
});
