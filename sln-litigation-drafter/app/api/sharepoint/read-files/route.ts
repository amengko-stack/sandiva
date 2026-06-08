import { NextRequest } from "next/server";
import { readFileContent } from "@/lib/sharepoint";
import { writeBlobText } from "@/lib/blob";
import type { FileEntry } from "@/types";

export const maxDuration = 300;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const BATCH_SIZE = 5;

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const { files, sessionId } = (await req.json()) as {
    files: FileEntry[];
    sessionId: string;
  };

  if (!files?.length || !sessionId) {
    return new Response(
      JSON.stringify({ error: "files dan sessionId wajib diisi" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();
  const total = files.length;
  const skipped: string[] = [];
  const documentTexts: { name: string; content: string }[] = [];

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: object) =>
        controller.enqueue(encoder.encode(sse(data)));

      try {
        for (let batchStart = 0; batchStart < total; batchStart += BATCH_SIZE) {
          const batch = files.slice(batchStart, batchStart + BATCH_SIZE);

          await Promise.all(
            batch.map(async (file, batchIndex) => {
              const globalIndex = batchStart + batchIndex;
              enqueue({ progress: globalIndex + 1, total, name: file.name });

              // Size check: parse size string "123 KB" → bytes
              const sizeKb = parseFloat(file.size) || 0;
              if (sizeKb > 0 && sizeKb * 1024 > MAX_FILE_BYTES) {
                skipped.push(file.name);
                enqueue({ skipped: file.name, reason: "Ukuran file melebihi 5 MB" });
                return;
              }

              try {
                const content = await readFileContent(file.path);
                documentTexts.push({ name: file.name, content });
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                skipped.push(file.name);
                enqueue({ skipped: file.name, reason: msg });
              }
            })
          );
        }

        // Store combined text in Blob keyed by sessionId
        const combined = documentTexts
          .map((d) => `=== ${d.name} ===\n${d.content}`)
          .join("\n\n");

        await writeBlobText(`sessions/${sessionId}/documents.txt`, combined);

        enqueue({ done: true, total, processed: documentTexts.length, skipped });
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
