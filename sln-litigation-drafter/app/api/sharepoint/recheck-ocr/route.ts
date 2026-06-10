import { NextRequest, NextResponse } from "next/server";
import { extractWithTier, getFileLastModified } from "@/lib/sharepoint";
import { readBlobText, writeBlobText } from "@/lib/blob";
import { writeExtractionCache, type ExtractionMetadata } from "@/lib/extraction-cache";
import { formatDocBlock } from "@/lib/extract-format";
import type { FileEntry, DocMapEntry, DocCategory, DocDocumentType, ExtractReport } from "@/types";

export const maxDuration = 300;

interface RecheckResult {
  name: string;
  status: "selesai" | "perlu_ocr" | "gagal";
  charCount?: number;
  method?: string;
  reason?: string;
}

// Re-extract ONLY the files previously flagged PERLU_OCR. Files that now carry
// a text layer are extracted and appended to the session's combined Blob and
// report.json without disturbing anything already extracted.
export async function POST(req: NextRequest) {
  const { sessionId, folderPath, files, docMap } = (await req.json()) as {
    sessionId: string;
    folderPath?: string;
    files: FileEntry[];
    docMap: DocMapEntry[];
  };

  if (!sessionId || !files?.length) {
    return NextResponse.json({ error: "sessionId dan files wajib diisi" }, { status: 400 });
  }

  const mapById = new Map<string, DocMapEntry>(docMap?.map((e) => [e.fileId, e]) ?? []);

  // Load existing combined text + report so we append rather than overwrite.
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

    try {
      const { content, extractionMethod, needsOcr } = await extractWithTier(file.path, file.name, category);
      if (needsOcr) {
        results.push({ name: file.name, status: "perlu_ocr" });
        continue;
      }

      const currentModifiedAt = await getFileLastModified(file.path);
      const metadata: ExtractionMetadata = {
        filename: file.name,
        category,
        extractionMethod,
        characterCount: content.length,
        extractedAt: new Date().toISOString(),
        sharePointPath: file.path,
        fileModifiedAt: currentModifiedAt ?? "",
      };
      appended += formatDocBlock(metadata, content);
      await writeExtractionCache(file.path, { content, metadata });
      addedChars += content.length;
      addedProcessed += 1;

      // Flip the matching report entry from perlu_ocr → selesai.
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
  }

  // Persist the appended text + updated report (only if something new extracted).
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
