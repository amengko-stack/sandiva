import { NextRequest, NextResponse } from "next/server";
import { extractWithTier, getFileLastModified } from "@/lib/sharepoint";
import { readBlobText, writeBlobText } from "@/lib/blob";
import { writeExtractionCache, type ExtractionMetadata } from "@/lib/extraction-cache";
import { formatDocBlock } from "@/lib/extract-format";
import type { FileEntry, DocMapEntry, DocCategory, DocDocumentType, ExtractReport } from "@/types";

export const maxDuration = 300;

type RecheckStatus = "selesai" | "perlu_ocr" | "ocr_gagal" | "tidak_ditemukan" | "gagal";

interface RecheckResult {
  name: string;
  status: RecheckStatus;
  charCount?: number;
  method?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Sharing-link helpers (mirrors graph-client.ts / sharepoint.ts)
// ---------------------------------------------------------------------------
function encodeSharingUrl(url: string): string {
  const b64 = Buffer.from(url).toString("base64");
  return "u!" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getGraphToken(): Promise<string> {
  const tenantId = process.env.AZURE_TENANT_ID!;
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.AZURE_CLIENT_ID!,
    client_secret: process.env.AZURE_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    body: params,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure token error ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.access_token as string;
}

async function graphGet(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

interface OcrFolderItem {
  id: string;
  name: string;
  file?: object;
}

// Resolve an OCR folder sharing link to driveId + itemId, then list its files.
async function listOcrFolderFiles(ocrFolderPath: string): Promise<{ driveId: string; items: OcrFolderItem[] }> {
  const token = await getGraphToken();
  const shareId = encodeSharingUrl(ocrFolderPath);

  const metaRes = await graphGet(
    `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem?$select=id,parentReference`,
    token,
  );
  if (!metaRes.ok) {
    const text = await metaRes.text();
    throw new Error(`Gagal membuka folder OCR (${metaRes.status}): ${text.slice(0, 300)}`);
  }
  const meta = await metaRes.json() as { id: string; parentReference?: { driveId?: string } };
  const driveId = meta.parentReference?.driveId;
  if (!driveId) throw new Error("Folder OCR: driveId tidak ditemukan dari sharing link");

  const listRes = await graphGet(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${meta.id}/children?$select=id,name,file`,
    token,
  );
  if (!listRes.ok) {
    const text = await listRes.text();
    throw new Error(`Gagal membaca isi folder OCR (${listRes.status}): ${text.slice(0, 300)}`);
  }
  const data = await listRes.json() as { value?: OcrFolderItem[] };
  return { driveId, items: (data.value ?? []).filter((i) => i.file) };
}

// Normalize a filename for matching: lowercase, strip extension, strip trailing _ocr.
function normalizeForMatch(name: string): string {
  const base = name.split(".").slice(0, -1).join(".") || name; // strip extension
  return base.toLowerCase().replace(/_ocr$/, "");
}

// Re-extract ONLY the files previously flagged PERLU_OCR. Files are sourced
// from a dedicated OCR folder (separate sharing link) rather than the original
// matter path, so the originals are untouched. Matched by filename (case-
// insensitive, _OCR-suffix-tolerant).
export async function POST(req: NextRequest) {
  const { sessionId, ocrFolderPath, files, docMap } = (await req.json()) as {
    sessionId: string;
    ocrFolderPath: string;
    files: FileEntry[];
    docMap: DocMapEntry[];
  };

  if (!sessionId || !files?.length) {
    return NextResponse.json({ error: "sessionId dan files wajib diisi" }, { status: 400 });
  }
  if (!ocrFolderPath?.trim()) {
    return NextResponse.json({ error: "ocrFolderPath wajib diisi" }, { status: 400 });
  }

  const mapById = new Map<string, DocMapEntry>(docMap?.map((e) => [e.fileId, e]) ?? []);

  // Resolve OCR folder and list its files.
  let driveId: string;
  let ocrItems: OcrFolderItem[];
  try {
    const result = await listOcrFolderFiles(ocrFolderPath.trim());
    driveId = result.driveId;
    ocrItems = result.items;
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Gagal membaca folder OCR" }, { status: 400 });
  }

  // Build a lookup: normalized base name → OCR item
  const ocrByNorm = new Map<string, OcrFolderItem>();
  for (const item of ocrItems) {
    ocrByNorm.set(normalizeForMatch(item.name), item);
  }

  // Load existing combined text + report for append.
  const existingText = (await readBlobText(`sessions/${sessionId}/extracted_text.json`)) ?? "";
  let report: ExtractReport | null = null;
  try {
    const raw = await readBlobText(`sessions/${sessionId}/report.json`);
    if (raw) report = JSON.parse(raw) as ExtractReport;
  } catch {
    report = null;
  }

  const results: RecheckResult[] = [];
  let appended = "";
  let addedChars = 0;
  let addedProcessed = 0;

  for (const file of files) {
    const entry = mapById.get(file.id);
    const category: DocCategory = entry?.category ?? "REFERENSI";
    const documentType: DocDocumentType = entry?.documentType ?? "tidak_dikenali";

    const normOriginal = normalizeForMatch(file.name);
    const ocrItem = ocrByNorm.get(normOriginal);

    if (!ocrItem) {
      results.push({ name: file.name, status: "tidak_ditemukan" });
      continue;
    }

    // File found in OCR folder — extract using drive: path so downloadBytes uses
    // the drive API (same format used for sharing-link folder files).
    const ocrPath = `drive:${driveId}:${ocrItem.id}`;

    try {
      // Use the ORIGINAL filename so metadata, cache key, and report entries are consistent.
      const { content, extractionMethod, needsOcr } = await extractWithTier(ocrPath, file.name, category);
      if (needsOcr) {
        results.push({ name: file.name, status: "ocr_gagal" });
        continue;
      }

      const currentModifiedAt = await getFileLastModified(ocrPath);
      const metadata: ExtractionMetadata = {
        filename: file.name,
        category,
        extractionMethod,
        characterCount: content.length,
        extractedAt: new Date().toISOString(),
        sharePointPath: ocrPath,
        fileModifiedAt: currentModifiedAt ?? "",
      };
      appended += formatDocBlock(metadata, content);
      await writeExtractionCache(ocrPath, { content, metadata });
      addedChars += content.length;
      addedProcessed += 1;

      if (report) {
        const rf = report.files.find((f) => f.name === file.name && f.status === "perlu_ocr");
        if (rf) {
          rf.status = "selesai";
          rf.extractionMode = extractionMethod;
          rf.charCount = content.length;
        }
      }

      results.push({ name: file.name, status: "selesai", charCount: content.length, method: extractionMethod });
    } catch (e: unknown) {
      results.push({ name: file.name, status: "gagal", reason: e instanceof Error ? e.message : String(e) });
    }

    // Suppress unused variable warning — documentType is present for future report use.
    void documentType;
  }

  if (appended) {
    await writeBlobText(`sessions/${sessionId}/extracted_text.json`, existingText + appended);
    if (report) {
      report.totalChars += addedChars;
      report.processed += addedProcessed;
      report.ocrRequired = Math.max(0, (report.ocrRequired ?? 0) - addedProcessed);
      await writeBlobText(`sessions/${sessionId}/report.json`, JSON.stringify(report));
    }
  }

  return NextResponse.json({ results });
}
