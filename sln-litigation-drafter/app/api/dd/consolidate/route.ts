import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { ddKeys } from "@/lib/dd/blob-keys";
import { consolidate } from "@/lib/dd/consolidate";
import type { DDClassifiedDoc, DDConsolidated, DDFinding, DDGapItem, DDTransaction } from "@/types/dd";

export const maxDuration = 300;

// Re-read a previously computed consolidation (mirrors GET /api/dd/findings).
// Without this the client's local consolidated object is lost on reload — and
// in a new tab the persisted `consolidated` flag is false even though the blob
// exists — so Stage 5 looked like consolidation had never run.
export async function GET(req: NextRequest) {
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "sessionId tidak valid" }, { status: 400 });
  }
  const raw = await readBlobText(ddKeys.consolidated(sessionId));
  return NextResponse.json({ consolidated: raw ? (JSON.parse(raw) as DDConsolidated) : null });
}

export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await req.json();
    if (!isValidSessionId(sessionId)) {
      return NextResponse.json({ error: "sessionId tidak valid" }, { status: 400 });
    }
    const txnRaw = await readBlobText(ddKeys.transaction(sessionId));
    if (!txnRaw) return NextResponse.json({ error: "transaction.json tidak ditemukan." }, { status: 400 });
    const txn = JSON.parse(txnRaw) as DDTransaction;

    const classifiedByEntity: Record<string, DDClassifiedDoc[]> = {};
    const findingsByEntity: Record<string, DDFinding[]> = {};
    const gapsByEntity: Record<string, DDGapItem[]> = {};
    for (const e of txn.entities) {
      const [c, f, g] = await Promise.all([
        readBlobText(ddKeys.classified(sessionId, e.id)),
        readBlobText(ddKeys.findings(sessionId, e.id)),
        readBlobText(ddKeys.gaps(sessionId, e.id)),
      ]);
      if (!f || !g) {
        return NextResponse.json({ error: `Analisis entitas ${e.name} belum selesai.` }, { status: 400 });
      }
      classifiedByEntity[e.id] = c ? JSON.parse(c) : [];
      findingsByEntity[e.id] = JSON.parse(f);
      gapsByEntity[e.id] = JSON.parse(g);
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const consolidated = await consolidate(client, { transaction: txn, classifiedByEntity, findingsByEntity, gapsByEntity });
    await writeBlobText(ddKeys.consolidated(sessionId), JSON.stringify(consolidated));
    return NextResponse.json({ consolidated });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
