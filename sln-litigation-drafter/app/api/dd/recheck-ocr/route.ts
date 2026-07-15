import { NextRequest, NextResponse } from "next/server";
import { extractWithTier, getFileLastModified } from "@/lib/sharepoint";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { writeExtractionCache, type ExtractionMetadata } from "@/lib/extraction-cache";
import { formatDocBlock } from "@/lib/extract-format";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { preCategorize } from "@/lib/dd/pre-categorize";
import type { DocCategory, ExtractReport } from "@/types";

export const maxDuration = 300;

type RecheckStatus = "selesai" | "ocr_gagal" | "gagal";

interface SelectedOcrFile {
  name: string;
  path: string;
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

// DD port of the litigation OCR re-check: extract the explicitly-selected
// OCR-folder files against the entity's blobs (selection + matching happen
// client-side). Matched files (replacesName set) clear the scanned original's
// PERLU_OCR slot in the entity report; unmatched files are added as new
// inventory entries. The scanned originals in the data room are never touched.
export async function POST(req: NextRequest) {
  try {
    const { sessionId, entityId, files } = (await req.json()) as {
      sessionId: string;
      entityId: string;
      files: SelectedOcrFile[];
    };

    if (!isValidSessionId(sessionId) || !isValidEntityId(entityId) || !files?.length) {
      return NextResponse.json(
        { error: "sessionId, entityId, dan files wajib diisi" },
        { status: 400 }
      );
    }

    // Load the entity's existing combined text + report for append.
    const existingText = (await readBlobText(ddKeys.extracted(sessionId, entityId))) ?? "";
    let report: ExtractReport | null = null;
    try {
      const raw = await readBlobText(ddKeys.report(sessionId, entityId));
      if (raw) report = JSON.parse(raw) as ExtractReport;
    } catch (e) {
      // A corrupt report must not wipe it or block extraction — results are
      // still returned; only the report update is skipped.
      console.error(
        "[dd-recheck-ocr] report.json parse failed, OCR results won't update the report:",
        e instanceof Error ? e.message : e
      );
      report = null;
    }

    const results: RecheckResult[] = [];
    let appended = "";

    for (const file of files) {
      // DD has no docMap — category comes from the filename tier heuristic,
      // keyed on the original's name when this file replaces a scanned one.
      const targetName = file.replacesName ?? file.name;
      const category: DocCategory = preCategorize(targetName);

      // Idempotency guard: if this OCR file's target is already recorded as
      // "selesai" (e.g. the same OCR folder was read and extracted twice),
      // skip re-extracting it so it never gets appended/counted as a duplicate.
      if (report?.files.some((f) => f.name === targetName && f.status === "selesai")) {
        results.push({
          name: targetName,
          replacesName: file.replacesName,
          status: "gagal",
          reason: "Dokumen sudah diekstrak sebelumnya — dilewati agar tidak duplikat.",
        });
        continue;
      }

      try {
        const { content, extractionMethod, needsOcr } = await extractWithTier(
          file.path,
          targetName,
          category
        );
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

        if (report) {
          const rf = file.replacesName
            ? report.files.find((f) => f.name === file.replacesName && f.status === "perlu_ocr")
            : undefined;
          if (rf) {
            rf.status = "selesai";
            rf.extractionMode = extractionMethod;
            rf.charCount = content.length;
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

        results.push({
          name: targetName,
          replacesName: file.replacesName,
          status: "selesai",
          charCount: content.length,
          method: extractionMethod,
        });

        // Persist after EVERY successful file — extraction here can involve
        // Claude OCR calls, and a maxDuration kill mid-loop must not discard
        // the (paid-for) files already completed.
        const blobKey = ddKeys.extracted(sessionId, entityId);
        const combined = existingText + appended;
        console.log(
          `[dd-recheck-ocr] WROTE blob: sessionId=${sessionId} entityId=${entityId} key=${blobKey} chars=${combined.length}`
        );
        await writeBlobText(blobKey, combined);
        if (report) {
          await writeBlobText(ddKeys.report(sessionId, entityId), JSON.stringify(report));
        }
      } catch (e: unknown) {
        results.push({
          name: targetName,
          replacesName: file.replacesName,
          status: "gagal",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (report && appended) {
      // Recompute counters from the merged files array (same semantics as
      // lib/dd/merge-report.ts) instead of adding deltas onto stale totals —
      // additive arithmetic here could double-count across repeated recheck runs.
      let processed = 0;
      let skipped = 0;
      let ocrRequired = 0;
      let totalChars = 0;
      for (const f of report.files) {
        if (f.status === "selesai") processed++;
        else if (f.status === "gagal") skipped++;
        else if (f.status === "perlu_ocr") ocrRequired++;
        totalChars += f.charCount ?? 0;
      }
      report.processed = processed;
      report.skipped = skipped;
      report.ocrRequired = ocrRequired;
      report.totalChars = totalChars;
      await writeBlobText(ddKeys.report(sessionId, entityId), JSON.stringify(report));
    }

    return NextResponse.json({ results });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Terjadi kesalahan saat memproses ulang OCR" },
      { status: 500 }
    );
  }
}
