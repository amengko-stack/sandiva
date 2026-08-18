import { NextRequest } from "next/server";
import { charCapFor, extractWithTier, getFileLastModified } from "@/lib/sharepoint";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { writeExtractionCache, type ExtractionMetadata } from "@/lib/extraction-cache";
import { formatDocBlock } from "@/lib/extract-format";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { preCategorize } from "@/lib/dd/pre-categorize";
import type { DocCategory, ExtractReport } from "@/types";

export const maxDuration = 300;

const CONCURRENCY = 3;

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

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// DD port of the litigation OCR re-check: extract the explicitly-selected
// OCR-folder files against the entity's blobs (selection + matching happen
// client-side). Matched files (replacesName set) clear the scanned original's
// PERLU_OCR slot in the entity report; unmatched files are added as new
// inventory entries. The scanned originals in the data room are never touched.
//
// Streamed (SSE) with CONCURRENCY batching, mirroring /api/dd/extract — a
// single blocking JSON response gave no progress feedback and, on a
// maxDuration timeout, surfaced only an opaque generic error to the client.
export async function POST(req: NextRequest) {
  const { sessionId, entityId, files } = (await req.json()) as {
    sessionId: string;
    entityId: string;
    files: SelectedOcrFile[];
  };

  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId) || !files?.length) {
    return new Response(
      JSON.stringify({ error: "sessionId, entityId, dan files wajib diisi" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const total = files.length;
  const encoder = new TextEncoder();

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

  // Per-index blocks, joined in array order on every batch write so
  // concurrent completion never scrambles combined-text order (same
  // discipline as /api/dd/extract).
  const docBlocks: (string | null)[] = new Array(total).fill(null);
  const results: (RecheckResult | null)[] = new Array(total).fill(null);

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) => {
        try {
          controller.enqueue(encoder.encode(sse(data)));
        } catch {
          // Controller already closed/errored (client disconnected) — nothing to send.
        }
      };

      const processFile = async (i: number) => {
        const file = files[i];
        // DD has no docMap — category comes from the filename tier heuristic,
        // keyed on the original's name when this file replaces a scanned one.
        const targetName = file.replacesName ?? file.name;
        const category: DocCategory = preCategorize(targetName);

        enqueue({ type: "start", name: targetName, index: i, total });

        // Idempotency guard: if this OCR file's target is already recorded as
        // "selesai" (e.g. the same OCR folder was read and extracted twice),
        // skip re-extracting it so it never gets appended/counted as a duplicate.
        if (report?.files.some((f) => f.name === targetName && f.status === "selesai")) {
          const reason = "Dokumen sudah diekstrak sebelumnya — dilewati agar tidak duplikat.";
          results[i] = { name: targetName, replacesName: file.replacesName, status: "gagal", reason };
          enqueue({ type: "error", name: targetName, reason, index: i, total });
          return;
        }

        try {
          const { content, extractionMethod, needsOcr } = await extractWithTier(
            file.path,
            targetName,
            category
          );

          if (needsOcr) {
            results[i] = { name: targetName, replacesName: file.replacesName, status: "ocr_gagal" };
            enqueue({ type: "ocr_required", name: targetName, index: i, total });
            return;
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
            charCap: charCapFor(category),
          };
          docBlocks[i] = formatDocBlock(metadata, content);
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

          results[i] = {
            name: targetName,
            replacesName: file.replacesName,
            status: "selesai",
            charCount: content.length,
            method: extractionMethod,
          };
          enqueue({
            type: "done",
            name: targetName,
            charCount: content.length,
            method: extractionMethod,
            index: i,
            total,
          });
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          results[i] = { name: targetName, replacesName: file.replacesName, status: "gagal", reason };
          enqueue({ type: "error", name: targetName, reason, index: i, total });
        }
      };

      try {
        const totalBatches = Math.ceil(total / CONCURRENCY);
        for (let b = 0; b < totalBatches; b++) {
          const startIdx = b * CONCURRENCY;
          const indices = Array.from(
            { length: Math.min(CONCURRENCY, total - startIdx) },
            (_, k) => startIdx + k
          );

          // allSettled: one failure must never cancel the others in the batch.
          await Promise.allSettled(indices.map(processFile));

          // Persist after every batch — a maxDuration kill mid-run must not
          // discard the (paid-for) files already completed.
          const appended = docBlocks.filter((bk): bk is string => bk !== null).join("");
          if (appended) {
            await writeBlobText(ddKeys.extracted(sessionId, entityId), existingText + appended);
          }
          if (report) {
            await writeBlobText(ddKeys.report(sessionId, entityId), JSON.stringify(report));
          }

          enqueue({ type: "batch_end", batch: b + 1, totalBatches });
        }

        if (report && docBlocks.some((bk) => bk !== null)) {
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

        const finalResults = results.filter((r): r is RecheckResult => r !== null);
        enqueue({ type: "complete", results: finalResults });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Terjadi kesalahan saat memproses ulang OCR";
        enqueue({ error: msg });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
