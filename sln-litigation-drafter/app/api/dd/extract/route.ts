import { NextRequest } from "next/server";
import { extractWithTier, getFileLastModified } from "@/lib/sharepoint";
import { readExtractionCache, writeExtractionCache, type ExtractionMetadata } from "@/lib/extraction-cache";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { formatDocBlock } from "@/lib/extract-format";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { preCategorize } from "@/lib/dd/pre-categorize";
import type { FileEntry, DocCategory, DocDocumentType, ExtractReport } from "@/types";

export const maxDuration = 300;

const CONCURRENCY = 3;

const METHOD_LABEL: Record<string, string> = {
  full:           "Teks penuh",
  structured:     "Terstruktur (pihak, kewajiban, pembayaran, penalti)",
  truncated_30k:  "Teks penuh (30 ribu karakter pertama)",
  summary_5k:     "Ringkas (5 ribu karakter pertama)",
  pdf_text:       "Teks penuh (PDF, per halaman)",
  perlu_ocr:      "Perlu OCR (dokumen pindaian)",
};

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const { sessionId, entityId, files, appendToExisting } =
    (await req.json()) as {
      sessionId: string;
      entityId: string;
      files: FileEntry[];
      // true on resume: this run only re-extracts the remaining files, so the
      // already-extracted text must be preserved as a prefix, not overwritten.
      appendToExisting?: boolean;
    };

  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId) || !files?.length) {
    return new Response(
      JSON.stringify({ error: "sessionId, entityId, dan files wajib diisi" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Sort: KRITIS → PENDUKUNG (DD reads everything, but material docs surface first)
  const sorted = [...files].sort((a, b) =>
    preCategorize(a.name) === preCategorize(b.name) ? 0 : preCategorize(a.name) === "KRITIS" ? -1 : 1
  );

  const total = sorted.length;
  const encoder = new TextEncoder();
  let processed = 0;
  let skipped = 0;
  let totalChars = 0;
  let cacheHits = 0;
  let ocrRequired = 0;

  // Per-index document blocks, joined in order on every Blob write so parallel
  // completion never scrambles the combined text.
  const docBlocks: (string | null)[] = new Array(total).fill(null);
  const reportFiles: ExtractReport["files"] = new Array(total);

  // On resume (or a subsequent chunk when the entity's files were split into
  // batches), only the remaining files are (re-)extracted; preserve the text
  // and report already written for previously-completed files/chunks so we
  // never overwrite-and-lose — the coverage panel must reflect ALL chunks.
  let existingPrefix = "";
  let existingReport: ExtractReport | null = null;
  if (appendToExisting) {
    const [prefixText, reportRaw] = await Promise.all([
      readBlobText(ddKeys.extracted(sessionId, entityId)),
      readBlobText(ddKeys.report(sessionId, entityId)),
    ]);
    existingPrefix = prefixText ?? "";
    if (reportRaw) {
      try { existingReport = JSON.parse(reportRaw) as ExtractReport; } catch { existingReport = null; }
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) =>
        controller.enqueue(encoder.encode(sse(data)));

      const isBlank = (s: string) => s.replace(/\s+/g, "").length === 0;

      const processFile = async (i: number) => {
        const file = sorted[i];
        const category: DocCategory = preCategorize(file.name);
        const documentType: DocDocumentType = "tidak_dikenali";

        enqueue({ type: "start", name: file.name, category, index: i, total });

        // No size gate — every file is read fully or partially, never skipped for size.
        try {
          const currentModifiedAt = await getFileLastModified(file.path);

          // Cache: valid when fileModifiedAt matches AND under 7 days old
          const cached = await readExtractionCache(file.path, currentModifiedAt, category);
          if (cached && isBlank(cached.content)) {
            // Stale empty cache entry — fall through to fresh extraction.
            console.log(`[read-files] cache-hit empty → fall through name=${file.name}`);
          } else if (cached) {
            cacheHits++;
            processed++;
            totalChars += cached.content.length;
            docBlocks[i] = formatDocBlock(cached.metadata, cached.content);
            reportFiles[i] = {
              name: file.name, category, documentType,
              extractionMode: `${METHOD_LABEL[cached.metadata.extractionMethod] ?? cached.metadata.extractionMethod} [Dari Cache]`,
              status: "selesai", charCount: cached.content.length,
            };
            enqueue({ type: "done", name: file.name, category, charCount: cached.content.length, index: i, total, fromCache: true, method: cached.metadata.extractionMethod });
            return;
          }

          const { content, extractionMethod, needsOcr } = await extractWithTier(file.path, file.name, category);

          // Scanned PDF with no text layer — flagged for external OCR. Not cached,
          // not counted as processed/failed; the drafter re-checks after OCR.
          if (needsOcr) {
            ocrRequired++;
            reportFiles[i] = {
              name: file.name, category, documentType,
              extractionMode: "Perlu OCR", status: "perlu_ocr",
            };
            enqueue({ type: "ocr_required", name: file.name, category, index: i, total });
            return;
          }

          // A blank extraction must never be reported "selesai" — the file
          // would silently contribute zero text to the analysis.
          if (isBlank(content)) {
            const reason = "Tidak ada teks yang dapat diekstrak — file kemungkinan kosong atau rusak. Konversi ke .docx atau PDF lalu coba lagi.";
            skipped++;
            reportFiles[i] = { name: file.name, category, documentType, extractionMode: "—", status: "gagal", reason };
            enqueue({ type: "error", name: file.name, category, reason, index: i, total });
            return;
          }

          const metadata: ExtractionMetadata = {
            filename: file.name,
            category,
            extractionMethod,
            characterCount: content.length,
            extractedAt: new Date().toISOString(),
            sharePointPath: file.path,
            fileModifiedAt: currentModifiedAt ?? "",
          };
          docBlocks[i] = formatDocBlock(metadata, content);
          await writeExtractionCache(file.path, { content, metadata });

          processed++;
          totalChars += content.length;
          reportFiles[i] = {
            name: file.name, category, documentType,
            extractionMode: METHOD_LABEL[extractionMethod] ?? extractionMethod,
            status: "selesai", charCount: content.length,
          };
          enqueue({ type: "done", name: file.name, category, charCount: content.length, index: i, total, fromCache: false, method: extractionMethod });
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          skipped++;
          reportFiles[i] = { name: file.name, category, documentType, extractionMode: "—", status: "gagal", reason };
          enqueue({ type: "error", name: file.name, category, reason, index: i, total });
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

          // allSettled: one failure must never cancel the others in the batch
          await Promise.allSettled(indices.map(processFile));

          // Write combined Blob after every batch so partial progress survives.
          // Guard: Vercel Blob rejects empty body — skip write if no text extracted yet.
          const combinedText = existingPrefix + docBlocks.filter((bk): bk is string => bk !== null).join("");
          if (combinedText) {
            await writeBlobText(ddKeys.extracted(sessionId, entityId), combinedText);
          }

          enqueue({
            type: "batch_end",
            batch: b + 1,
            totalBatches,
            nextIndex: startIdx + indices.length,
            cacheHits,
          });
        }

        // Final assembly: write the complete combined document exactly once more
        // after every batch finishes, so the blob analyze reads is guaranteed to
        // reflect all successfully-extracted files (not just the last batch's).
        const finalCombined = existingPrefix + docBlocks.filter((bk): bk is string => bk !== null).join("");
        const blobKey = ddKeys.extracted(sessionId, entityId);
        if (finalCombined) {
          console.log(`[read-files] WROTE blob: sessionId=${sessionId} key=${blobKey} chars=${finalCombined.length}`);
          await writeBlobText(blobKey, finalCombined);
        } else {
          console.log(`[read-files] NO WRITE: sessionId=${sessionId} key=${blobKey} — no extracted text (all PERLU_OCR / failed)`);
        }

        // Audit report JSON for inventory PDF generation. On a chunked/resumed
        // run, merge in the prior chunk's report — prepend its files and add
        // its counts — so the coverage panel reflects the whole entity, not
        // just this chunk.
        const report: ExtractReport = {
          sessionId,
          folderPath: "",
          docTypeId: "dd",
          practiceAreaId: null,
          claimType: null,
          ref: entityId,
          timestamp: new Date().toISOString(),
          files: [...(existingReport?.files ?? []), ...reportFiles.filter(Boolean)],
          totalChars: (existingReport?.totalChars ?? 0) + totalChars,
          processed: (existingReport?.processed ?? 0) + processed,
          skipped: (existingReport?.skipped ?? 0) + skipped,
          cacheHits: (existingReport?.cacheHits ?? 0) + cacheHits,
          ocrRequired: (existingReport?.ocrRequired ?? 0) + ocrRequired,
        };
        await writeBlobText(ddKeys.report(sessionId, entityId), JSON.stringify(report));

        enqueue({ type: "complete", processed, skipped, totalChars, cacheHits, ocrRequired });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Stream error";
        try {
          enqueue({ error: msg });
        } catch {
          // Controller already closed/errored (client disconnected) — nothing to send.
        }
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
