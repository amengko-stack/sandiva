import { NextRequest } from "next/server";
import { readFileContentWithMode } from "@/lib/sharepoint";
import { writeBlobText } from "@/lib/blob";
import type { FileEntry, DocMapEntry, DocCategory, DocDocumentType, ExtractReport } from "@/types";

export const maxDuration = 300;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

const CATEGORY_ORDER: DocCategory[] = ["KRITIS", "PENDUKUNG", "REFERENSI"];

const EXTRACTION_MODE: Record<DocDocumentType, string> = {
  perjanjian_kontrak: "Terstruktur (ekstrak pihak, kewajiban, penalti)",
  putusan_penetapan:  "Teks penuh",
  surat_menyurat:     "Teks penuh",
  bukti_transaksi:    "Ringkasan",
  dokumen_korporasi:  "Ringkasan",
  tidak_dikenali:     "Teks penuh",
};

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
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
  let combinedText = "";
  let processed = 0;
  let skipped = 0;
  let totalChars = 0;

  const reportFiles: ExtractReport["files"] = [];

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) =>
        controller.enqueue(encoder.encode(sse(data)));

      try {
        for (let i = 0; i < sorted.length; i++) {
          const file = sorted[i];
          const entry = mapById.get(file.id);
          const category: DocCategory = entry?.category ?? "REFERENSI";
          const documentType: DocDocumentType = entry?.documentType ?? "tidak_dikenali";
          const extractionMode = EXTRACTION_MODE[documentType];

          enqueue({ type: "start", name: file.name, category, index: i, total });

          const sizeKb = parseFloat(file.size) || 0;
          if (sizeKb > 0 && sizeKb * 1024 > MAX_FILE_BYTES) {
            skipped++;
            const reason = "Ukuran file melebihi 5 MB";
            reportFiles.push({ name: file.name, category, documentType, extractionMode, status: "gagal", reason });
            enqueue({ type: "error", name: file.name, category, reason, index: i, total });
            continue;
          }

          try {
            const content = await readFileContentWithMode(file.path, documentType);
            combinedText += `=== ${file.name} ===\n${content}\n\n`;
            processed++;
            totalChars += content.length;
            reportFiles.push({ name: file.name, category, documentType, extractionMode, status: "selesai", charCount: content.length });
            enqueue({ type: "done", name: file.name, category, charCount: content.length, index: i, total });
          } catch (e: unknown) {
            const reason = e instanceof Error ? e.message : String(e);
            skipped++;
            reportFiles.push({ name: file.name, category, documentType, extractionMode, status: "gagal", reason });
            enqueue({ type: "error", name: file.name, category, reason, index: i, total });
          }

          // Write Blob after every file so partial progress survives timeouts
          await writeBlobText(`sessions/${sessionId}/documents.txt`, combinedText);
        }

        // Write audit report JSON for inventory PDF generation
        const report: ExtractReport = {
          sessionId,
          folderPath: folderPath ?? "",
          docTypeId: docTypeId ?? "",
          practiceAreaId: practiceAreaId ?? null,
          claimType: claimType ?? null,
          ref: ref ?? "",
          timestamp: new Date().toISOString(),
          files: reportFiles,
          totalChars,
          processed,
          skipped,
        };
        await writeBlobText(`sessions/${sessionId}/report.json`, JSON.stringify(report));

        enqueue({ type: "complete", processed, skipped, totalChars });
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
