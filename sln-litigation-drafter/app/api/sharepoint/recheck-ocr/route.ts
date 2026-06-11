import { NextRequest, NextResponse } from "next/server";
import { extractWithTier, getFileLastModified } from "@/lib/sharepoint";
import { readBlobText, writeBlobText } from "@/lib/blob";
import { writeExtractionCache, type ExtractionMetadata } from "@/lib/extraction-cache";
import { formatDocBlock } from "@/lib/extract-format";
import type { DocCategory, ExtractReport } from "@/types";

export const maxDuration = 300;

type RecheckStatus = "selesai" | "ocr_gagal" | "gagal";

interface SelectedOcrFile {
  name: string;
  path: string;
  category: DocCategory;
  replacesName?: string; // the scanned original's filename when this OCR file replaces it
}

interface RecheckResult {
  name: string;
  replacesName?: string;
  status: RecheckStatus;
  charCount?: number;
  method?: string;
  reason?: string;
}

// Extract the explicitly-selected OCR-folder files (selection + matching happen
// client-side). Matched files (replacesName set) clear the scanned original's
// PERLU_OCR slot; unmatched files are added as new inventory entries. The
// scanned originals in the main matter folder are never touched.
export async function POST(req: NextRequest) {
  const { sessionId, files } = (await req.json()) as {
    sessionId: string;
    files: SelectedOcrFile[];
  };

  if (!sessionId || !files?.length) {
    return NextResponse.json({ error: "sessionId dan files wajib diisi" }, { status: 400 });
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
  let clearedOcr = 0;

  for (const file of files) {
    const category: DocCategory = file.category ?? "REFERENSI";
    const targetName = file.replacesName ?? file.name;

    try {
      const { content, extractionMethod, needsOcr } = await extractWithTier(file.path, targetName, category);
      if (needsOcr) {
        results.push({ name: targetName, replacesName: file.replacesName, status: "ocr_gagal" });
        continue;
      }

      const currentModifiedAt = await getFileLastModified(file.path);
      const metadata: ExtractionMetadata = {
        filename: targetName,
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

      if (report) {
        const rf = file.replacesName
          ? report.files.find((f) => f.name === file.replacesName && f.status === "perlu_ocr")
          : undefined;
        if (rf) {
          rf.status = "selesai";
          rf.extractionMode = extractionMethod;
          rf.charCount = content.length;
          clearedOcr += 1;
        } else {
          // Newly-added document (no PERLU_OCR slot) — insert a fresh inventory entry.
          report.files.push({
            name: targetName,
            category,
            documentType: "tidak_dikenali",
            extractionMode: extractionMethod,
            status: "selesai",
            charCount: content.length,
          });
        }
      }

      results.push({ name: targetName, replacesName: file.replacesName, status: "selesai", charCount: content.length, method: extractionMethod });
    } catch (e: unknown) {
      results.push({ name: targetName, replacesName: file.replacesName, status: "gagal", reason: e instanceof Error ? e.message : String(e) });
    }
  }

  if (appended) {
    await writeBlobText(`sessions/${sessionId}/extracted_text.json`, existingText + appended);
    if (report) {
      report.totalChars += addedChars;
      report.processed += addedProcessed;
      report.ocrRequired = Math.max(0, (report.ocrRequired ?? 0) - clearedOcr);
      await writeBlobText(`sessions/${sessionId}/report.json`, JSON.stringify(report));
    }
  }

  return NextResponse.json({ results });
}
