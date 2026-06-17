import { NextRequest } from "next/server";
import { extractWithTier, getFileLastModified } from "@/lib/sharepoint";
import { readExtractionCache, writeExtractionCache, type ExtractionMetadata } from "@/lib/extraction-cache";
import { readBlobText, writeBlobText } from "@/lib/blob";
import { formatDocBlock } from "@/lib/extract-format";
import type { FileEntry, DocMapEntry, DocCategory, DocDocumentType, ExtractReport } from "@/types";

export const maxDuration = 300;

const CONCURRENCY = 3;
const CATEGORY_ORDER: DocCategory[] = ["KRITIS", "PENDUKUNG", "REFERENSI"];

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

// Add documents mid-workflow. Mirrors read-files' batched-SSE + cache + OCR
// handling, but APPENDS to the session's combined text and MERGES into the
// existing report.json (never overwrites) — modeled on recheck-ocr's
// append-and-merge semantics. Reuses extractWithTier (pipeline untouched).
export async function POST(req: NextRequest) {
  const { files, docMap, sessionId, folderPath, docTypeId, practiceAreaId, claimType, ref } =
    (await req.json()) as {
      files: FileEntry[];
      docMap: DocMapEntry[];
      sessionId: string;
      folderPath?: string;
      docTypeId?: string;
      practiceAreaId?: string | null;
      claimType?: string | null;
      ref?: string;
    };

  if (!files?.length || !sessionId) {
    return new Response(
      JSON.stringify({ error: "files dan sessionId wajib diisi" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const mapById = new Map<string, DocMapEntry>(docMap?.map((e) => [e.fileId, e]) ?? []);

  const sorted = [...files].sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(mapById.get(a.id)?.category ?? "REFERENSI");
    const cb = CATEGORY_ORDER.indexOf(mapById.get(b.id)?.category ?? "REFERENSI");
    return ca - cb;
  });

  const total = sorted.length;
  const encoder = new TextEncoder();
  let processed = 0;
  let skipped = 0;
  let addedChars = 0;
  let cacheHits = 0;
  let ocrRequired = 0;

  const docBlocks: (string | null)[] = new Array(total).fill(null);
  const newReportFiles: ExtractReport["files"] = new Array(total);
  const addedFiles: { id: string; name: string; category: DocCategory }[] = [];

  // Prior combined text and report — preserved, never overwritten.
  const oldText = (await readBlobText(`sessions/${sessionId}/extracted_text.json`)) ?? "";
  const oldChars = oldText.length;
  let priorReport: ExtractReport | null = null;
  try {
    const raw = await readBlobText(`sessions/${sessionId}/report.json`);
    if (raw) priorReport = JSON.parse(raw) as ExtractReport;
  } catch {
    priorReport = null;
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) => controller.enqueue(encoder.encode(sse(data)));

      const processFile = async (i: number) => {
        const file = sorted[i];
        const entry = mapById.get(file.id);
        const category: DocCategory = entry?.category ?? "REFERENSI";
        const documentType: DocDocumentType = entry?.documentType ?? "tidak_dikenali";

        enqueue({ type: "start", name: file.name, category, index: i, total });

        try {
          const currentModifiedAt = await getFileLastModified(file.path);

          const cached = await readExtractionCache(file.path, currentModifiedAt, category);
          if (cached) {
            cacheHits++;
            processed++;
            addedChars += cached.content.length;
            docBlocks[i] = formatDocBlock(cached.metadata, cached.content);
            newReportFiles[i] = {
              name: file.name, category, documentType,
              extractionMode: `${METHOD_LABEL[cached.metadata.extractionMethod] ?? cached.metadata.extractionMethod} [Dari Cache]`,
              status: "selesai", charCount: cached.content.length,
            };
            addedFiles.push({ id: file.id, name: file.name, category });
            enqueue({ type: "done", name: file.name, category, charCount: cached.content.length, index: i, total, fromCache: true, method: cached.metadata.extractionMethod });
            return;
          }

          const { content, extractionMethod, needsOcr } = await extractWithTier(file.path, file.name, category);

          if (needsOcr) {
            ocrRequired++;
            newReportFiles[i] = {
              name: file.name, category, documentType,
              extractionMode: "Perlu OCR", status: "perlu_ocr",
            };
            addedFiles.push({ id: file.id, name: file.name, category });
            enqueue({ type: "ocr_required", name: file.name, category, index: i, total });
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
          addedChars += content.length;
          newReportFiles[i] = {
            name: file.name, category, documentType,
            extractionMode: METHOD_LABEL[extractionMethod] ?? extractionMethod,
            status: "selesai", charCount: content.length,
          };
          addedFiles.push({ id: file.id, name: file.name, category });
          enqueue({ type: "done", name: file.name, category, charCount: content.length, index: i, total, fromCache: false, method: extractionMethod });
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          skipped++;
          newReportFiles[i] = { name: file.name, category, documentType, extractionMode: "—", status: "gagal", reason };
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
          await Promise.allSettled(indices.map(processFile));

          // Append-only: prior text + all new blocks so far.
          const combined = oldText + docBlocks.filter((bk): bk is string => bk !== null).join("");
          if (combined) {
            await writeBlobText(`sessions/${sessionId}/extracted_text.json`, combined);
          }

          enqueue({ type: "batch_end", batch: b + 1, totalBatches, nextIndex: startIdx + indices.length, cacheHits });
        }

        const finalCombined = oldText + docBlocks.filter((bk): bk is string => bk !== null).join("");
        const newTotal = finalCombined.length;
        const blobKey = `sessions/${sessionId}/extracted_text.json`;
        if (finalCombined) {
          await writeBlobText(blobKey, finalCombined);
        }
        console.log(`[add-docs] old=${oldChars} added=${addedChars} total=${newTotal} files=${addedFiles.length}`);

        // Merge into existing report.json (push new entries, recompute totals).
        const newFiles = newReportFiles.filter(Boolean);
        const mergedReport: ExtractReport = priorReport
          ? {
              ...priorReport,
              timestamp: new Date().toISOString(),
              files: [...priorReport.files, ...newFiles],
              totalChars: (priorReport.totalChars ?? 0) + addedChars,
              processed: (priorReport.processed ?? 0) + processed,
              skipped: (priorReport.skipped ?? 0) + skipped,
              cacheHits: (priorReport.cacheHits ?? 0) + cacheHits,
              ocrRequired: (priorReport.ocrRequired ?? 0) + ocrRequired,
            }
          : {
              sessionId,
              folderPath: folderPath ?? "",
              docTypeId: docTypeId ?? "",
              practiceAreaId: practiceAreaId ?? null,
              claimType: claimType ?? null,
              ref: ref ?? "",
              timestamp: new Date().toISOString(),
              files: newFiles,
              totalChars: addedChars,
              processed,
              skipped,
              cacheHits,
              ocrRequired,
            };
        await writeBlobText(`sessions/${sessionId}/report.json`, JSON.stringify(mergedReport));

        enqueue({ type: "complete", processed, skipped, addedChars, oldChars, newTotal, ocrRequired, addedFiles });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Stream error";
        enqueue({ error: msg });
      } finally {
        controller.close();
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
