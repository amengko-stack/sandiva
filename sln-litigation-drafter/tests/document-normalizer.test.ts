import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionMetadata } from "@/lib/extraction-cache";

const sharepoint = vi.hoisted(() => ({
  charCapFor: vi.fn(),
  extractWithTier: vi.fn(),
  getFileLastModified: vi.fn(),
}));

const cache = vi.hoisted(() => ({
  readExtractionCache: vi.fn(),
  writeExtractionCache: vi.fn(),
}));

const format = vi.hoisted(() => ({
  formatDocBlock: vi.fn(),
}));

const shadow = vi.hoisted(() => ({
  observeDocumentShadow: vi.fn(),
}));

vi.mock("@/lib/sharepoint", () => sharepoint);
vi.mock("@/lib/extraction-cache", () => cache);
vi.mock("@/lib/extract-format", () => format);
vi.mock("@/lib/document-shadow-runtime", () => shadow);

import { documentNormalizer } from "@/lib/document-normalizer";
import { createDisabledShadowPublisher, publishShadowDetached } from "@/lib/document-shadow-stage1/publisher";

const metadata: ExtractionMetadata = {
  filename: "Akta Pendirian.pdf",
  category: "KRITIS",
  extractionMethod: "pdf_text",
  characterCount: 18,
  extractedAt: "2026-08-19T07:00:00.000Z",
  sharePointPath: "/sites/matter/Akta Pendirian.pdf",
  fileModifiedAt: "2026-08-18T07:00:00.000Z",
  charCap: 200_000,
};

describe("DocumentNormalizer compatibility facade", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves extraction output including OCR and truncation signals", async () => {
    const legacyResult = {
      content: "teks\n\n[TERPOTONG — hanya 200.000 karakter pertama]",
      extractionMethod: "pdf_text",
      needsOcr: true,
    };
    sharepoint.extractWithTier.mockResolvedValue(legacyResult);

    const result = await documentNormalizer.extractWithTier(
      "/sites/matter/Akta Pendirian.pdf",
      "Akta Pendirian.pdf",
      "KRITIS",
    );

    expect(result).toBe(legacyResult);
    expect(sharepoint.extractWithTier).toHaveBeenCalledWith(
      "/sites/matter/Akta Pendirian.pdf",
      "Akta Pendirian.pdf",
      "KRITIS",
    );
  });

  it("preserves cache validation inputs and cached provenance", async () => {
    const cached = { content: "cached text", metadata };
    cache.readExtractionCache.mockResolvedValue(cached);

    const result = await documentNormalizer.readExtractionCache(
      metadata.sharePointPath,
      metadata.fileModifiedAt,
      metadata.category,
      metadata.charCap,
    );

    expect(result).toBe(cached);
    expect(cache.readExtractionCache).toHaveBeenCalledWith(
      metadata.sharePointPath,
      metadata.fileModifiedAt,
      metadata.category,
      metadata.charCap,
    );
  });

  it("preserves cache writes and provenance block formatting", async () => {
    const entry = { content: "extracted text", metadata };
    cache.writeExtractionCache.mockResolvedValue(undefined);
    format.formatDocBlock.mockReturnValue("formatted provenance block");

    await documentNormalizer.writeExtractionCache(metadata.sharePointPath, entry);
    const block = documentNormalizer.formatDocBlock(metadata, entry.content);

    expect(cache.writeExtractionCache).toHaveBeenCalledWith(metadata.sharePointPath, entry);
    expect(format.formatDocBlock).toHaveBeenCalledWith(metadata, entry.content);
    expect(block).toBe("formatted provenance block");
  });

  it("preserves source metadata and category depth without reinterpretation", async () => {
    sharepoint.getFileLastModified.mockResolvedValue(metadata.fileModifiedAt);
    sharepoint.charCapFor.mockReturnValue(metadata.charCap);

    await expect(documentNormalizer.getFileLastModified(metadata.sharePointPath))
      .resolves.toBe(metadata.fileModifiedAt);
    expect(documentNormalizer.charCapFor(metadata.category)).toBe(metadata.charCap);
  });

  it("does not translate extraction failures", async () => {
    const failure = new Error("Graph download failed");
    sharepoint.extractWithTier.mockRejectedValue(failure);

    await expect(documentNormalizer.extractWithTier("/file", "file.pdf", "PENDUKUNG"))
      .rejects.toBe(failure);
  });

  it("exposes shadow measurement without changing production extraction", async () => {
    const observation = {
      sourceBytes: Buffer.from("immutable source"),
      fileName: "agreement.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sourceRevision: "rev-1",
      tenantId: "tenant-a",
      matterId: "matter-a",
      documentId: "document-a",
      primaryText: "authoritative primary text",
    };
    shadow.observeDocumentShadow.mockResolvedValue(undefined);

    await documentNormalizer.runShadowComparison(observation);

    expect(shadow.observeDocumentShadow).toHaveBeenCalledWith(observation);
    expect(sharepoint.extractWithTier).not.toHaveBeenCalled();
    expect(cache.writeExtractionCache).not.toHaveBeenCalled();
  });

  it("keeps disabled Stage 1 handoff detached from extraction, caches, and user-visible output", async () => {
    const authoritativeOutput = {
      content: "authoritative primary text",
      extractionMethod: "mammoth",
      needsOcr: false,
    };
    sharepoint.extractWithTier.mockResolvedValue(authoritativeOutput);

    const result = await documentNormalizer.extractWithTier("/file", "agreement.docx", "KRITIS");
    publishShadowDetached(createDisabledShadowPublisher(), {
      tenantId: "tenant-a",
      sourceRevision: "rev-1",
      sourceBytes: Buffer.from("immutable bytes"),
      fileClass: "docx",
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(result).toBe(authoritativeOutput);
    expect(sharepoint.extractWithTier).toHaveBeenCalledOnce();
    expect(cache.readExtractionCache).not.toHaveBeenCalled();
    expect(cache.writeExtractionCache).not.toHaveBeenCalled();
    expect(format.formatDocBlock).not.toHaveBeenCalled();
  });
});
