import { describe, it, expect, vi, beforeEach } from "vitest";

// The extraction cache compared the category, and the read depth is derived from the
// category — so raising a cap changed nothing a cached entry could notice. A document
// already extracted at the old limit would have been served truncated indefinitely,
// which is how six financial statements would have stayed cut at 30,000 characters
// after the very change made to stop cutting them.
//
// Third cache in one day whose key described the request rather than the result.

const cacheBlob = vi.hoisted(() => ({
  readBlobText: vi.fn(),
  writeBlobText: vi.fn(),
}));
vi.mock("@/lib/blob", () => ({
  readBlobText: (...a: unknown[]) => cacheBlob.readBlobText(...a),
  writeBlobText: (...a: unknown[]) => cacheBlob.writeBlobText(...a),
}));

// Static import, not `await import` — vi.mock is hoisted above it either way, and a
// top-level await here fails `tsc --noEmit` under this tsconfig.
import { cacheKey, readExtractionCache, writeExtractionCache } from "@/lib/extraction-cache";

const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    content: "isi dokumen",
    metadata: {
      filename: "LK.pdf",
      category: "KRITIS",
      extractionMethod: "pdf_text",
      characterCount: 11,
      extractedAt: new Date().toISOString(),
      sharePointPath: "drive:x",
      fileModifiedAt: "2026-01-01T00:00:00.000Z",
      charCap: 200_000,
      ...over,
    },
  });

describe("readExtractionCache and the read depth", () => {
  beforeEach(() => {
    cacheBlob.readBlobText.mockReset();
    cacheBlob.writeBlobText.mockReset();
  });

  it("serves an entry read at least as deeply as this run would read", async () => {
    cacheBlob.readBlobText.mockResolvedValue(entry());
    const hit = await readExtractionCache("drive:x", "2026-01-01T00:00:00.000Z", "KRITIS", 200_000);
    expect(hit?.content).toBe("isi dokumen");
  });

  it("refuses an entry cut at a shallower limit than now applies", async () => {
    cacheBlob.readBlobText.mockResolvedValue(entry({ charCap: 80_000 }));
    const hit = await readExtractionCache("drive:x", "2026-01-01T00:00:00.000Z", "KRITIS", 200_000);
    expect(hit).toBeNull();
  });

  // Entries written before the field existed cannot prove how deeply they were read,
  // so they are re-extracted once rather than trusted.
  it("refuses an entry that does not record its depth", async () => {
    cacheBlob.readBlobText.mockResolvedValue(entry({ charCap: undefined }));
    const hit = await readExtractionCache("drive:x", "2026-01-01T00:00:00.000Z", "KRITIS", 200_000);
    expect(hit).toBeNull();
  });

  it("still serves when the caller does not care about depth", async () => {
    cacheBlob.readBlobText.mockResolvedValue(entry({ charCap: undefined }));
    const hit = await readExtractionCache("drive:x", "2026-01-01T00:00:00.000Z", "KRITIS");
    expect(hit?.content).toBe("isi dokumen");
  });

  it("keeps refusing on the checks that were already there", async () => {
    cacheBlob.readBlobText.mockResolvedValue(entry());
    expect(await readExtractionCache("drive:x", "2026-06-01T00:00:00.000Z", "KRITIS", 200_000)).toBeNull();
    expect(await readExtractionCache("drive:x", "2026-01-01T00:00:00.000Z", "PENDUKUNG", 120_000)).toBeNull();
  });

  it("uses a separate cache namespace for authoritative source text", () => {
    expect(cacheKey("drive:x", "source")).not.toBe(cacheKey("drive:x"));
    expect(cacheKey("drive:x", "source")).toContain("cache/source/");
  });

  it("refuses a legacy summary-only entry when authoritative source is required", async () => {
    cacheBlob.readBlobText.mockResolvedValue(entry({ extractionMethod: "structured" }));

    const hit = await readExtractionCache(
      "drive:x",
      "2026-01-01T00:00:00.000Z",
      "KRITIS",
      200_000,
      "source",
    );

    expect(hit).toBeNull();
    expect(cacheBlob.readBlobText).toHaveBeenCalledWith(cacheKey("drive:x", "source"));
  });

  it("serves and writes a cache entry only in its declared representation", async () => {
    const sourceEntry = JSON.parse(entry({ representation: "source", extractionMethod: "full" }));
    cacheBlob.readBlobText.mockResolvedValue(JSON.stringify(sourceEntry));

    await expect(
      readExtractionCache("drive:x", "2026-01-01T00:00:00.000Z", "KRITIS", 200_000, "source")
    ).resolves.toMatchObject({ content: "isi dokumen", metadata: { representation: "source" } });

    await writeExtractionCache("drive:x", sourceEntry);
    expect(cacheBlob.writeBlobText).toHaveBeenCalledWith(
      cacheKey("drive:x", "source"),
      JSON.stringify(sourceEntry),
    );
  });
});
