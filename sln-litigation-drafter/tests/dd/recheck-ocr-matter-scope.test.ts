import { beforeEach, describe, expect, it, vi } from "vitest";
import { ddKeys } from "@/lib/dd/blob-keys";

const mocks = vi.hoisted(() => ({
  readBlobText: vi.fn(),
  writeBlobText: vi.fn(),
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
    extractWithTier: mocks.extractWithTier,
    getFileLastModified: mocks.getFileLastModified,
    writeExtractionCache: mocks.writeExtractionCache,
    charCapFor: () => 30_000,
    formatDocBlock: () => "\nDOCUMENT\n",
  },
}));

import { POST } from "@/app/api/dd/recheck-ocr/route";

const SESSION_ID = "session-1";
const ENTITY_ID = "entity-1";
const ALPHA = "https://sandiva.sharepoint.com/sites/Matters/Shared Documents/Matter-Alpha";
const BETA = "https://sandiva.sharepoint.com/sites/Matters/Shared Documents/Matter-Beta";

const transaction = (roots: string[]) => ({
  id: SESSION_ID,
  name: "Matter Alpha",
  entities: roots.map((dataRoomPath, index) => ({
    id: `entity-${index + 1}`,
    name: `PT Alpha ${index + 1}`,
    role: "target",
    dataRoomPath,
    files: [],
  })),
});

const request = (files: Array<{ name: string; path: string }>, extra: Record<string, unknown> = {}) =>
  ({
    json: async () => ({ sessionId: SESSION_ID, entityId: ENTITY_ID, files, ...extra }),
  }) as Parameters<typeof POST>[0];

function loadPersistedTransaction(roots: string[]) {
  mocks.readBlobText.mockImplementation(async (key: string) => {
    if (key === ddKeys.transaction(SESSION_ID)) return JSON.stringify(transaction(roots));
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.extractWithTier.mockResolvedValue({
    content: "isi dokumen",
    extractionMethod: "pdf_text",
    needsOcr: false,
  });
  mocks.getFileLastModified.mockResolvedValue("2026-08-31T00:00:00.000Z");
});

describe("DD OCR recheck matter scope", () => {
  it("processes a path within the persisted matter root", async () => {
    loadPersistedTransaction([ALPHA]);

    const response = await POST(request([{ name: "Akta.pdf", path: `${ALPHA}/Korporasi/Akta.pdf` }]));
    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.extractWithTier).toHaveBeenCalledOnce();
  });

  it("rejects a path from another matter before document access", async () => {
    loadPersistedTransaction([ALPHA]);

    const response = await POST(request([{ name: "Rahasia.pdf", path: `${BETA}/Rahasia.pdf` }]));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("bukan bagian dari matter ini") });
    expect(mocks.readBlobText).toHaveBeenCalledTimes(1);
    expect(mocks.extractWithTier).not.toHaveBeenCalled();
    expect(mocks.getFileLastModified).not.toHaveBeenCalled();
    expect(mocks.writeExtractionCache).not.toHaveBeenCalled();
  });

  it("rejects a mixed request atomically before reading its valid files", async () => {
    loadPersistedTransaction([ALPHA]);

    const response = await POST(
      request([
        { name: "Valid-A.pdf", path: `${ALPHA}/Valid-A.pdf` },
        { name: "Valid-B.pdf", path: `${ALPHA}/Valid-B.pdf` },
        { name: "Foreign-C.pdf", path: `${BETA}/Foreign-C.pdf` },
      ])
    );

    expect(response.status).toBe(403);
    expect(mocks.readBlobText).toHaveBeenCalledTimes(1);
    expect(mocks.extractWithTier).not.toHaveBeenCalled();
    expect(mocks.getFileLastModified).not.toHaveBeenCalled();
    expect(mocks.writeExtractionCache).not.toHaveBeenCalled();
  });

  it("fails closed before document access when the matter has no registered root", async () => {
    loadPersistedTransaction([]);

    const response = await POST(request([{ name: "Akta.pdf", path: `${ALPHA}/Akta.pdf` }]));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("belum memiliki folder") });
    expect(mocks.readBlobText).toHaveBeenCalledTimes(1);
    expect(mocks.extractWithTier).not.toHaveBeenCalled();
    expect(mocks.getFileLastModified).not.toHaveBeenCalled();
    expect(mocks.writeExtractionCache).not.toHaveBeenCalled();
  });

  it("uses the active session's persisted matter rather than a client-supplied root", async () => {
    loadPersistedTransaction([ALPHA]);

    const response = await POST(
      request([{ name: "Rahasia.pdf", path: `${BETA}/Rahasia.pdf` }], {
        dataRoomPath: BETA,
        transaction: transaction([BETA]),
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.readBlobText).toHaveBeenCalledTimes(1);
    expect(mocks.extractWithTier).not.toHaveBeenCalled();
  });
});
