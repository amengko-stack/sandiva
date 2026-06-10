import { NextRequest } from "next/server";
import { extractWithTier, getFileLastModified } from "@/lib/sharepoint";
import { readExtractionCache, writeExtractionCache, type ExtractionMetadata } from "@/lib/extraction-cache";
import { writeBlobText } from "@/lib/blob";
import type { FileEntry, DocMapEntry, DocCategory, DocDocumentType, ExtractReport } from "@/types";

export const maxDuration = 300;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const CONCURRENCY = 3;

const CATEGORY_ORDER: DocCategory[] = ["KRITIS", "PENDUKUNG", "REFERENSI"];

const METHOD_LABEL: Record<string, string> = {
  full:          "Teks penuh",
  structured:    "Terstruktur (pihak, kewajiban, pembayaran, penalti)",
  truncated_30k: "Teks penuh (30 ribu karakter pertama)",
  summary_5k:    "Ringkas (5 ribu karakter pertama)",
};

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// Per-document block written to the combined Blob; the metadata header travels
// to Stage 3 so analysis knows what was fully vs partially extracted.
function formatDocBlock(meta: ExtractionMetadata, content: string): string {
  return (
    `=== ${meta.filename} ===\n` +
    `[Metadata: kategori=${meta.category}; metode=${meta.extractionMethod}; karakter=${meta.characterCount}; ` +
    `diekstrak=${meta.extractedAt}; path=${meta.sharePointPath}; dimodifikasi=${meta.fileModifiedAt}]\n` +
    `${content}\n\n`
  );
}

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

  // Sort: KRITIS → PENDUKUNG → REFERENSI
  const sorted = [...files].sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(mapById.get(a.id)?.category ?? "REFERENSI");
    const cb = CATEGORY_ORDER.indexOf(mapById.get(b.id)?.category ?? "REFERENSI");
    return ca - cb;
  });

  const total = sorted.length;
  const encoder = new TextEncoder();
  let processed = 0;
  let skipped = 0;
  let totalChars = 0;
  let cacheHits = 0;

  // Per-index document blocks, joined in order on every Blob write so parallel
  // completion never scrambles the combined text.
  const docBlocks: (string | null)[] = new Array(total).fill(null);
  const reportFiles: ExtractReport["files"] = new Array(total);

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) =>
        controller.enqueue(encoder.encode(sse(data)));

      const processFile = async (i: number) => {
        const file = sorted[i];
        const entry = mapById.get(file.id);
        const category: DocCategory = entry?.category ?? "REFERENSI";
        const documentType: DocDocumentType = entry?.documentType ?? "tidak_dikenali";

        enqueue({ type: "start", name: file.name, category, index: i, total });

        const sizeKb = parseFloat(file.size) || 0;
        if (sizeKb > 0 && sizeKb * 1024 > MAX_FILE_BYTES) {
          skipped++;
          const reason = "Ukuran file melebihi 5 MB";
          reportFiles[i] = { name: file.name, category, documentType, extractionMode: "—", status: "gagal", reason };
          enqueue({ type: "error", name: file.name, category, reason, index: i, total });
          return;
        }

        try {
          const currentModifiedAt = await getFileLastModified(file.path);

          // Cache: valid when fileModifiedAt matches AND under 7 days old
          const cached = await readExtractionCache(file.path, currentModifiedAt, category);
          if (cached) {
            cacheHits++;
            processed++;
            totalChars += cached.content.length;
            docBlocks[i] = formatDocBlock(cached.metadata, cached.content);
            reportFiles[i] = {
              name: file.name, category, documentType,
              extractionMode: `${METHOD_LABEL[cached.metadata.extractionMethod] ?? cached.metadata.extractionMethod} [Dari Cache]`,
              status: "selesai", charCount: cached.content.length,
            };
            enqueue({ type: "done", name: file.name, category, charCount: cached.content.length, index: i, total, fromCache: true });
            return;
          }

          const { content, extractionMethod } = await extractWithTier(file.path, file.name, category);
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
          enqueue({ type: "done", name: file.name, category, charCount: content.length, index: i, total, fromCache: false });
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

          // Write combined Blob after every batch so partial progress survives
          const combinedText = docBlocks.filter((bk): bk is string => bk !== null).join("");
          await writeBlobText(`sessions/${sessionId}/extracted_text.json`, combinedText);

          enqueue({
            type: "batch_end",
            batch: b + 1,
            totalBatches,
            nextIndex: startIdx + indices.length,
            cacheHits,
          });
        }

        // Audit report JSON for inventory PDF generation
        const report: ExtractReport = {
          sessionId,
          folderPath: folderPath ?? "",
          docTypeId: docTypeId ?? "",
          practiceAreaId: practiceAreaId ?? null,
          claimType: claimType ?? null,
          ref: ref ?? "",
          timestamp: new Date().toISOString(),
          files: reportFiles.filter(Boolean),
          totalChars,
          processed,
          skipped,
          cacheHits,
        };
        await writeBlobText(`sessions/${sessionId}/report.json`, JSON.stringify(report));

        enqueue({ type: "complete", processed, skipped, totalChars, cacheHits });
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
