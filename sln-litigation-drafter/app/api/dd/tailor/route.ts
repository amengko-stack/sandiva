import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { loadChecklist, resolveChecklist } from "@/lib/dd/checklist-loader";
import { tailorChecklist } from "@/lib/dd/tailor";
import { resolveRegime } from "@/lib/dd/regime";
import type { DDClassifiedDoc, DDTransaction } from "@/types/dd";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, entityId } = await req.json();
    if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
      return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
    }
    const [txnRaw, classifiedRaw] = await Promise.all([
      readBlobText(ddKeys.transaction(sessionId)),
      readBlobText(ddKeys.classified(sessionId, entityId)),
    ]);
    if (!txnRaw || !classifiedRaw) {
      return NextResponse.json({ error: "Klasifikasi belum tersedia untuk entitas ini." }, { status: 400 });
    }
    const txn = JSON.parse(txnRaw) as DDTransaction;
    const entity = txn.entities.find((e) => e.id === entityId);
    if (!entity) return NextResponse.json({ error: "Entitas tidak dikenal." }, { status: 400 });
    const classified = JSON.parse(classifiedRaw) as DDClassifiedDoc[];

    const cl = await loadChecklist();
    const resolved = resolveChecklist(cl, txn.type, undefined, resolveRegime(entity));
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const tailored = await tailorChecklist(client, {
      entityName: entity.name, transactionType: txn.type,
      classified, expected: resolved.expected,
    });
    await writeBlobText(ddKeys.tailored(sessionId, entityId), JSON.stringify(tailored));
    return NextResponse.json({ tailored });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
