import { NextRequest, NextResponse } from "next/server";
import { readBlobText, isValidSessionId } from "@/lib/blob";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { splitDocBlocks } from "@/lib/extract-format";
import type { DDTransaction } from "@/types/dd";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  const entityId = searchParams.get("entityId");
  const artifact = searchParams.get("artifact");
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "sessionId tidak valid" }, { status: 400 });
  }

  if (entityId) {
    if (!isValidEntityId(entityId)) {
      return NextResponse.json({ error: "entityId tidak valid" }, { status: 400 });
    }
    if (artifact === "report") {
      const raw = await readBlobText(ddKeys.report(sessionId, entityId));
      return NextResponse.json({ report: raw ? JSON.parse(raw) : null });
    }
    if (artifact === "extracted") {
      const file = searchParams.get("file");
      const raw = await readBlobText(ddKeys.extracted(sessionId, entityId));
      if (!raw) return NextResponse.json({ content: null });
      if (file) {
        const block = splitDocBlocks(raw).find((b) => b.fileName === file);
        return NextResponse.json({ content: block?.content ?? null });
      }
      return NextResponse.json({ content: raw });
    }
    return NextResponse.json({ error: "artifact tidak dikenal" }, { status: 400 });
  }

  const txnRaw = await readBlobText(ddKeys.transaction(sessionId));
  if (!txnRaw) return NextResponse.json({ exists: false, transaction: null, entities: {} });
  const txn = JSON.parse(txnRaw) as DDTransaction;
  const entities: Record<string, Record<string, boolean>> = {};
  for (const e of txn.entities) {
    const [ex, c, g, tb, f] = await Promise.all([
      readBlobText(ddKeys.extracted(sessionId, e.id)),
      readBlobText(ddKeys.classified(sessionId, e.id)),
      readBlobText(ddKeys.gaps(sessionId, e.id)),
      readBlobText(ddKeys.tables(sessionId, e.id)),
      readBlobText(ddKeys.findings(sessionId, e.id)),
    ]);
    entities[e.id] = { extracted: !!ex, classified: !!c, gaps: !!g, tables: !!tb, findings: !!f };
  }
  return NextResponse.json({ exists: true, transaction: txn, entities });
}
