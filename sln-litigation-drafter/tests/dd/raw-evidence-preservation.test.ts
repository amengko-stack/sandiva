import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkQuote } from "@/lib/dd/grounding";
import { formatDocBlock, splitDocBlocks } from "@/lib/extract-format";
import type { ExtractionMetadata } from "@/lib/extraction-cache";

const anthropicCreate = vi.hoisted(() => vi.fn());
const pdf = vi.hoisted(() => ({
  extractText: vi.fn(),
  getDocumentProxy: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: anthropicCreate };
  },
}));

vi.mock("unpdf", () => pdf);

import { extractWithTier } from "@/lib/sharepoint";

const SOURCE_QUOTE = "KALIMAT SUMBER UNIK C2 menetapkan kewajiban pembayaran penuh.";
const DERIVED_QUOTE = "KALIMAT PARAFRASE MODEL C2 menyebut pembayaran bersyarat.";
const DERIVED_SUMMARY = `Ringkasan model: ${DERIVED_QUOTE}`;

let sourceText = SOURCE_QUOTE;
let fixtureExtension = "txt";

const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("login.microsoftonline.com")) {
    return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("?$select=name")) {
    return new Response(JSON.stringify({ name: `fixture.${fixtureExtension}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.endsWith("/content")) {
    return new Response(sourceText, { status: 200 });
  }
  throw new Error(`Unexpected fetch in test: ${url}`);
});

vi.stubGlobal("fetch", fetchMock);

async function extractAuthoritative(fileName: string, category: "KRITIS" | "PENDUKUNG" = "KRITIS") {
  return extractWithTier("drive:test-drive:test-item", fileName, category, "source");
}

beforeEach(() => {
  sourceText = SOURCE_QUOTE;
  fixtureExtension = "txt";
  anthropicCreate.mockReset();
  anthropicCreate.mockResolvedValue({
    content: [{ type: "text", text: DERIVED_SUMMARY }],
  });
  pdf.getDocumentProxy.mockReset();
  pdf.getDocumentProxy.mockResolvedValue({ synthetic: true });
  pdf.extractText.mockReset();
  pdf.extractText.mockImplementation(async () => ({ text: sourceText, totalPages: 1 }));
});

afterAll(() => vi.unstubAllGlobals());

describe("C-2 authoritative source extraction", () => {
  it("preserves source-derived text for a deed whose filename matches akta", async () => {
    const result = await extractAuthoritative("Akta Pendirian PT C2.txt");

    expect(result).toEqual({ content: SOURCE_QUOTE, extractionMethod: "full" });
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it("preserves source-derived text through the text-PDF deed branch", async () => {
    fixtureExtension = "pdf";
    sourceText = `${SOURCE_QUOTE} ${"teks sumber tambahan ".repeat(8)}`;

    const result = await extractAuthoritative("Akta Pendirian PT C2.pdf");

    expect(result.content).toContain(SOURCE_QUOTE);
    expect(result.extractionMethod).toBe("pdf_text");
    expect(result.needsOcr).toBeUndefined();
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it("grounds a decisive deed quote found only in source and rejects one found only in the model summary", async () => {
    const result = await extractAuthoritative("Akta Perubahan PT C2.txt");

    expect(checkQuote(SOURCE_QUOTE, result.content).verdict).toBe("verified");
    expect(checkQuote(DERIVED_QUOTE, result.content).verdict).toBe("not_found");
  });

  it("selects source deterministically when source and derived wording conflict", async () => {
    const result = await extractAuthoritative("Akta Konflik PT C2.txt");

    expect(checkQuote(SOURCE_QUOTE, result.content).verdict).toBe("verified");
    expect(checkQuote(DERIVED_QUOTE, result.content).verdict).not.toBe("verified");
    expect(result.content).not.toContain(DERIVED_SUMMARY);
  });

  it("preserves source-derived text for a non-deed critical contract", async () => {
    const result = await extractAuthoritative("Perjanjian Kredit Material C2.txt");

    expect(result.content).toBe(SOURCE_QUOTE);
    expect(result.extractionMethod).toBe("full");
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it("keeps ordinary readable LDD extraction compatible", async () => {
    sourceText = "Dokumen pendukung biasa yang dapat dibaca.";

    await expect(extractAuthoritative("Daftar Aset.txt", "PENDUKUNG")).resolves.toEqual({
      content: sourceText,
      extractionMethod: "full",
    });
  });

  it("keeps the shared non-DD default structured-contract behavior unchanged", async () => {
    const result = await extractWithTier(
      "drive:test-drive:test-item",
      "Perjanjian Kredit Material C2.txt",
      "KRITIS",
    );

    expect(result).toEqual({
      content: `[Ekstraksi Terstruktur]\n${DERIVED_SUMMARY}`,
      extractionMethod: "structured",
    });
    expect(anthropicCreate).toHaveBeenCalledOnce();
  });

  it("round-trips source file identity and extraction provenance without derived content", () => {
    const metadata: ExtractionMetadata = {
      filename: "Akta Pendirian PT C2.txt",
      category: "KRITIS",
      extractionMethod: "full",
      characterCount: SOURCE_QUOTE.length,
      extractedAt: "2026-09-01T00:00:00.000Z",
      sharePointPath: "drive:test-drive:test-item",
      fileModifiedAt: "2026-08-31T00:00:00.000Z",
      charCap: 200_000,
      representation: "source",
    };

    const block = formatDocBlock(metadata, SOURCE_QUOTE);
    const parsed = splitDocBlocks(block);

    expect(block).toContain("metode=full");
    expect(block).toContain("path=drive:test-drive:test-item");
    expect(block).not.toContain("[Ekstraksi Terstruktur]");
    expect(parsed).toEqual([{
      fileName: "Akta Pendirian PT C2.txt",
      category: "KRITIS",
      content: SOURCE_QUOTE,
    }]);
  });
});
