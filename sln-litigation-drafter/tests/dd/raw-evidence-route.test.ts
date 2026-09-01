import { beforeEach, describe, expect, it, vi } from "vitest";
import { ddKeys } from "@/lib/dd/blob-keys";

const SOURCE = "KALIMAT SUMBER UNIK C2 tetap menjadi bukti yang berwenang.";
const DERIVED = "KALIMAT PARAFRASE MODEL C2 menggantikan bukti.";

const mocks = vi.hoisted(() => ({
  readBlobText: vi.fn(),
  writeBlobText: vi.fn(),
  readExtractionCache: vi.fn(),
  extractWithTier: vi.fn(),
  getFileLastModified: vi.fn(),
  writeExtractionCache: vi.fn(),
}));

vi.mock("@/lib/blob", () => ({
  readBlobText: mocks.readBlobText,
  writeBlobText: mocks.writeBlobText,
  isValidSessionId: () => true,
}));

vi.mock("@/lib/document-normalizer", () => ({
  documentNormalizer: {
    charCapFor: () => 200_000,
    getFileLastModified: mocks.getFileLastModified,
    readExtractionCache: mocks.readExtractionCache,
    extractWithTier: mocks.extractWithTier,
    writeExtractionCache: mocks.writeExtractionCache,
    formatDocBlock: (_metadata: unknown, content: string) => `SOURCE-BLOCK\n${content}\n`,
  },
}));

import { POST } from "@/app/api/dd/extract/route";

const SESSION_ID = "session-c2";
const ENTITY_ID = "entity-c2";
const ROOT = "https://sandiva.sharepoint.com/sites/Matters/Shared Documents/Matter-C2";
const FILE_PATH = `${ROOT}/Korporasi/Akta Pendirian C2.txt`;

const transaction = {
  id: SESSION_ID,
  name: "Matter C2",
  type: "acquisition",
  entities: [{ id: ENTITY_ID, name: "PT C2", role: "target", dataRoomPath: ROOT, files: [] }],
};

const request = {
  json: async () => ({
    sessionId: SESSION_ID,
    entityId: ENTITY_ID,
    files: [{
      id: "file-c2",
      name: "Akta Pendirian C2.txt",
      path: FILE_PATH,
      size: "1 KB",
      type: "txt",
      selected: true,
      folder: "Korporasi",
    }],
  }),
} as Parameters<typeof POST>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readBlobText.mockImplementation(async (key: string) =>
    key === ddKeys.transaction(SESSION_ID) ? JSON.stringify(transaction) : null
  );
  mocks.getFileLastModified.mockResolvedValue("2026-09-01T00:00:00.000Z");
  mocks.readExtractionCache.mockImplementation(
    async (_path: string, _modified: string, _category: string, _cap: number, representation?: string) =>
      representation === "source"
        ? null
        : {
            content: DERIVED,
            metadata: {
              filename: "Akta Pendirian C2.txt",
              category: "KRITIS",
              extractionMethod: "structured",
              characterCount: DERIVED.length,
              extractedAt: "2026-09-01T00:00:00.000Z",
              sharePointPath: FILE_PATH,
              fileModifiedAt: "2026-09-01T00:00:00.000Z",
              charCap: 200_000,
            },
          }
  );
  mocks.extractWithTier.mockImplementation(
    async (_path: string, _name: string, _category: string, representation?: string) => ({
      content: representation === "source" ? SOURCE : DERIVED,
      extractionMethod: representation === "source" ? "full" : "structured",
      needsOcr: false,
    })
  );
});

describe("C-2 DD extraction route", () => {
  it("persists source text even when a compatible-looking derived cache entry exists", async () => {
    const response = await POST(request);
    await response.text();

    expect(response.status).toBe(200);
    const extractedWrite = mocks.writeBlobText.mock.calls.find(
      ([key]) => key === ddKeys.extracted(SESSION_ID, ENTITY_ID)
    );
    expect(extractedWrite?.[1]).toContain(SOURCE);
    expect(extractedWrite?.[1]).not.toContain(DERIVED);

    const cachedWrite = mocks.writeExtractionCache.mock.calls[0]?.[1];
    expect(cachedWrite?.metadata.representation).toBe("source");
    expect(cachedWrite?.content).toBe(SOURCE);
  });

  it("persists the same authoritative source representation on a compatible source-cache hit", async () => {
    mocks.readExtractionCache.mockResolvedValueOnce({
      content: SOURCE,
      metadata: {
        filename: "Akta Pendirian C2.txt",
        category: "KRITIS",
        extractionMethod: "full",
        characterCount: SOURCE.length,
        extractedAt: "2026-09-01T00:00:00.000Z",
        sharePointPath: FILE_PATH,
        fileModifiedAt: "2026-09-01T00:00:00.000Z",
        charCap: 200_000,
        representation: "source",
      },
    });

    const response = await POST(request);
    await response.text();

    const extractedWrite = mocks.writeBlobText.mock.calls.find(
      ([key]) => key === ddKeys.extracted(SESSION_ID, ENTITY_ID)
    );
    expect(extractedWrite?.[1]).toContain(SOURCE);
    expect(extractedWrite?.[1]).not.toContain(DERIVED);
    expect(mocks.extractWithTier).not.toHaveBeenCalled();
    expect(mocks.writeExtractionCache).not.toHaveBeenCalled();
  });
});
