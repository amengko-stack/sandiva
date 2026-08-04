import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { splitDocBlocks } from "@/lib/extract-format";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { groupAgreements } from "@/lib/dd/group";
import { extractTableRow } from "@/lib/dd/extract-table";
import { loadChecklist } from "@/lib/dd/checklist-loader";
import type { DDClassifiedDoc, DDExtractionRow, DDTransaction } from "@/types/dd";

export const maxDuration = 300;

const MAX_GROUPS_PER_RUN = 40;
const MAX_CONSECUTIVE_API_ERRORS = 3;
const CONCURRENCY = 3;
const enc = new TextEncoder();

type Msg =
  | { type: "start"; total: number }
  | { type: "row"; row: DDExtractionRow; index: number; total: number }
  | { type: "warning"; message: string }
  | { type: "done"; rows: DDExtractionRow[] }
  | { type: "error"; message: string };

const emit = (c: ReadableStreamDefaultController<Uint8Array>, m: Msg) =>
  c.enqueue(enc.encode(JSON.stringify(m) + "\n"));

export async function POST(req: NextRequest) {
  const { sessionId, entityId } = (await req.json()) as { sessionId: string; entityId: string };
  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
    return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
  }

  const [combined, txnRaw, classifiedRaw] = await Promise.all([
    readBlobText(ddKeys.extracted(sessionId, entityId)),
    readBlobText(ddKeys.transaction(sessionId)),
    readBlobText(ddKeys.classified(sessionId, entityId)),
  ]);
  if (!combined || !txnRaw || !classifiedRaw) {
    return NextResponse.json({ error: "Selesaikan ekstraksi dan klasifikasi entitas ini dahulu." }, { status: 400 });
  }
  const txn = JSON.parse(txnRaw) as DDTransaction;
  const classified = JSON.parse(classifiedRaw) as DDClassifiedDoc[];
  const cl = await loadChecklist();

  const blocks = splitDocBlocks(combined);
  const contentByFile = new Map(blocks.map((b) => [b.fileName, b.content]));
  const allGroups = groupAgreements(classified, entityId);
  const groups = allGroups.slice(0, MAX_GROUPS_PER_RUN);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        emit(controller, { type: "start", total: groups.length });
        if (allGroups.length > MAX_GROUPS_PER_RUN) {
          emit(controller, { type: "warning", message: `Batas ${MAX_GROUPS_PER_RUN} perjanjian per run tercapai.` });
        }
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const rows: (DDExtractionRow | null)[] = new Array(groups.length).fill(null);
        let consecutiveErrors = 0;

        const one = async (i: number) => {
          const g = groups[i];
          try {
            const contents = g.memberFiles
              .map((f) => `=== ${f} ===\n${contentByFile.get(f) ?? "[TIDAK DITEMUKAN]"}`)
              .join("\n\n");
            rows[i] = await extractTableRow(client, {
              group: g, contents, entityId, fields: cl.extractionFields, transactionType: txn.type,
            });
            consecutiveErrors = 0;
          } catch (e) {
            consecutiveErrors++;
            rows[i] = {
              groupId: g.groupId, entityId, agreementLabel: g.label, memberFiles: g.memberFiles,
              cells: [], status: "gagal", reason: e instanceof Error ? e.message : String(e),
            };
          }
          emit(controller, { type: "row", row: rows[i]!, index: i, total: groups.length });
        };

        for (let b = 0; b < groups.length; b += CONCURRENCY) {
          const idx = Array.from({ length: Math.min(CONCURRENCY, groups.length - b) }, (_, k) => b + k);
          await Promise.allSettled(idx.map(one));
          if (consecutiveErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            throw new Error(`${MAX_CONSECUTIVE_API_ERRORS}+ panggilan API gagal berturut-turut — dihentikan.`);
          }
          const soFar = rows.filter((r): r is DDExtractionRow => r !== null);
          if (soFar.length) await writeBlobText(ddKeys.tables(sessionId, entityId), JSON.stringify(soFar));
        }

        emit(controller, { type: "done", rows: rows.filter((r): r is DDExtractionRow => r !== null) });
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
