import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { splitDocBlocks } from "@/lib/extract-format";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { classifyDoc } from "@/lib/dd/classify";
import { loadChecklist, resolveChecklist } from "@/lib/dd/checklist-loader";
import type { DDClassifiedDoc, DDTransaction } from "@/types/dd";

export const maxDuration = 300;

const MAX_DOCS_PER_RUN = 60;
const MAX_CONSECUTIVE_API_ERRORS = 3;
const CONCURRENCY = 3;
const enc = new TextEncoder();

type Msg =
  | { type: "start"; total: number }
  | { type: "doc"; doc: DDClassifiedDoc; index: number; total: number }
  | { type: "warning"; message: string }
  | { type: "done"; docs: DDClassifiedDoc[] }
  | { type: "error"; message: string };

const emit = (c: ReadableStreamDefaultController<Uint8Array>, m: Msg) =>
  c.enqueue(enc.encode(JSON.stringify(m) + "\n"));

export async function POST(req: NextRequest) {
  const { sessionId, entityId } = (await req.json()) as { sessionId: string; entityId: string };
  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
    return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
  }

  const [combined, txnRaw] = await Promise.all([
    readBlobText(ddKeys.extracted(sessionId, entityId)),
    readBlobText(ddKeys.transaction(sessionId)),
  ]);
  if (!combined || combined.length < 50) {
    return NextResponse.json({ error: "Belum ada teks untuk entitas ini — selesaikan ekstraksi dahulu." }, { status: 400 });
  }
  if (!txnRaw) {
    return NextResponse.json({ error: "transaction.json tidak ditemukan — ulangi Stage 1." }, { status: 400 });
  }
  const txn = JSON.parse(txnRaw) as DDTransaction;
  const entity = txn.entities.find((e) => e.id === entityId);
  if (!entity) return NextResponse.json({ error: "Entitas tidak dikenal." }, { status: 400 });

  const cl = await loadChecklist();
  const resolved = resolveChecklist(cl, txn.type);

  const allBlocks = splitDocBlocks(combined);
  const blocks = allBlocks.slice(0, MAX_DOCS_PER_RUN);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        emit(controller, { type: "start", total: blocks.length });
        if (allBlocks.length > MAX_DOCS_PER_RUN) {
          emit(controller, { type: "warning", message: `Batas ${MAX_DOCS_PER_RUN} dokumen per run — jalankan ulang untuk sisanya.` });
        }
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const docs: (DDClassifiedDoc | null)[] = new Array(blocks.length).fill(null);
        let consecutiveErrors = 0;

        const one = async (i: number) => {
          try {
            docs[i] = await classifyDoc(client, {
              fileName: blocks[i].fileName, content: blocks[i].content,
              entityId, entityName: entity.name, transactionType: txn.type,
              expected: resolved.expected,
            });
            consecutiveErrors = 0;
          } catch (e) {
            consecutiveErrors++;
            docs[i] = {
              fileName: blocks[i].fileName, entityId, aspectId: "perjanjian_penting",
              expectedDocId: null, docLabel: blocks[i].fileName, docDate: null,
              parties: [], summary: "", confidence: "rendah",
              reasoning: `GAGAL: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
          emit(controller, { type: "doc", doc: docs[i]!, index: i, total: blocks.length });
        };

        for (let b = 0; b < blocks.length; b += CONCURRENCY) {
          const idx = Array.from({ length: Math.min(CONCURRENCY, blocks.length - b) }, (_, k) => b + k);
          await Promise.allSettled(idx.map(one));
          if (consecutiveErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new Error(`${MAX_CONSECUTIVE_API_ERRORS}+ panggilan API gagal berturut-turut — dihentikan.`);
          }
          const soFar = docs.filter((d): d is DDClassifiedDoc => d !== null);
          if (soFar.length) await writeBlobText(ddKeys.classified(sessionId, entityId), JSON.stringify(soFar));
        }

        const final = docs.filter((d): d is DDClassifiedDoc => d !== null);
        emit(controller, { type: "done", docs: final });
      } catch (e) {
        try { emit(controller, { type: "error", message: e instanceof Error ? e.message : "Error" }); } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
  });
}
