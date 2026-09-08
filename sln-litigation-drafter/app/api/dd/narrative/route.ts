import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { splitDocBlocks } from "@/lib/extract-format";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { extractNarrativeSectionI } from "@/lib/dd/narrative";
import { parseStoredJson, priorNarrativeTime, validNarrativeClassification } from "@/lib/dd/narrative-coverage";
import type { DDClassifiedDoc, DDEntity, DDNarrativeSectionI, DDTransaction } from "@/types/dd";

export const maxDuration = 300;

const enc = new TextEncoder();

type Msg =
  | { type: "start" }
  | { type: "step"; message: string }
  | { type: "done"; narrative: DDNarrativeSectionI }
  | { type: "error"; message: string; previousGeneratedAt?: string | null };

const emit = (c: ReadableStreamDefaultController<Uint8Array>, m: Msg) =>
  c.enqueue(enc.encode(JSON.stringify(m) + "\n"));

export async function POST(req: NextRequest) {
  const body: unknown = await req.json().catch(() => null);
  const { sessionId, entityId } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
    return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
  }

  const [combined, txnRaw, classifiedRaw, reportRaw, previousRaw] = await Promise.all([
    readBlobText(ddKeys.extracted(sessionId, entityId)),
    readBlobText(ddKeys.transaction(sessionId)),
    readBlobText(ddKeys.classified(sessionId, entityId)),
    readBlobText(ddKeys.report(sessionId, entityId)),
    readBlobText(ddKeys.narrative(sessionId, entityId)),
  ]);
  if (combined === null || !txnRaw || !classifiedRaw) {
    return NextResponse.json({ error: "Selesaikan ekstraksi dan klasifikasi entitas ini dahulu." }, { status: 400 });
  }
  const txn = parseStoredJson(txnRaw) as DDTransaction | null;
  const classifiedValue = parseStoredJson(classifiedRaw);
  if (!validNarrativeClassification(classifiedValue, entityId)) {
    return NextResponse.json({ error: "Klasifikasi dokumen tidak sesuai dengan entitas ini." }, { status: 400 });
  }
  const classified = classifiedValue as DDClassifiedDoc[];
  const entity = Array.isArray(txn?.entities) ? txn.entities.find((e: DDEntity) => e && e.id === entityId) : null;
  if (!entity || typeof entity.name !== "string") {
    return NextResponse.json({ error: "Entitas tidak ditemukan pada transaksi ini." }, { status: 400 });
  }

  const blocks = splitDocBlocks(combined);
  const contentByFile = new Map(blocks.map((b) => [b.fileName, b.content]));
  const previousGeneratedAt = priorNarrativeTime(parseStoredJson(previousRaw), entityId);
  const extractReport = parseStoredJson(reportRaw);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        emit(controller, { type: "start" });
        emit(controller, { type: "step", message: "Menyusun narasi Bagian I (pendirian, permodalan, pengurus)..." });

        const client = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        let narrative: DDNarrativeSectionI;
        try {
          narrative = await extractNarrativeSectionI(client, {
            entityId,
            entityName: entity.name,
            classified,
            contentByFile,
            extractReport,
          });
        } catch (e) {
          emit(controller, {
            type: "error",
            message: "Penyusunan Profil Perseroan belum berhasil diselesaikan. Jalankan ulang penyusunan sebelum mengekspor hasil terbaru.",
            previousGeneratedAt,
          });
          return;
        }

        // Persist BEFORE emitting done — a maxDuration kill runs no catch/finally,
        // so anything not written before that point is lost.
        await writeBlobText(ddKeys.narrative(sessionId, entityId), JSON.stringify(narrative));

        emit(controller, { type: "done", narrative });
      } catch (e) {
        try { emit(controller, { type: "error", message: "Hasil Profil Perseroan belum dapat disimpan. Jalankan ulang penyusunan.", previousGeneratedAt }); } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
  });
}
