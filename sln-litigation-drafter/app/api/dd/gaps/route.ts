import { NextRequest, NextResponse } from "next/server";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { loadChecklist, resolveChecklist } from "@/lib/dd/checklist-loader";
import { computeGaps } from "@/lib/dd/gap-engine";
import type { DDClassifiedDoc, DDTailorResult, DDTransaction } from "@/types/dd";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body.action === "save-transaction") {
      const txn = body.transaction as DDTransaction;
      if (!isValidSessionId(txn?.id) || !Array.isArray(txn.entities) || txn.entities.some((e) => !isValidEntityId(e.id))) {
        return NextResponse.json({ error: "transaction tidak valid" }, { status: 400 });
      }
      await writeBlobText(ddKeys.transaction(txn.id), JSON.stringify(txn));
      return NextResponse.json({ ok: true });
    }

    if (body.action === "compute") {
      const { sessionId, entityId, notApplicableIds } = body as {
        sessionId: string; entityId: string; notApplicableIds?: string[];
      };
      if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
        return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
      }
      const [txnRaw, classifiedRaw, tailoredRaw] = await Promise.all([
        readBlobText(ddKeys.transaction(sessionId)),
        readBlobText(ddKeys.classified(sessionId, entityId)),
        readBlobText(ddKeys.tailored(sessionId, entityId)),
      ]);
      if (!txnRaw || !classifiedRaw) {
        return NextResponse.json({ error: "Klasifikasi belum tersedia." }, { status: 400 });
      }
      const txn = JSON.parse(txnRaw) as DDTransaction;
      const classified = JSON.parse(classifiedRaw) as DDClassifiedDoc[];
      const tailored = tailoredRaw ? (JSON.parse(tailoredRaw) as DDTailorResult) : null;

      const cl = await loadChecklist();
      const resolved = resolveChecklist(cl, txn.type, tailored?.added);
      const gaps = computeGaps({
        expected: resolved.expected,
        classified,
        entityId,
        transactionType: txn.type,
        cutoffDateISO: txn.cutoffDateISO,
        notApplicableIds,
      });
      await writeBlobText(ddKeys.gaps(sessionId, entityId), JSON.stringify(gaps));
      return NextResponse.json({ gaps });
    }

    return NextResponse.json({ error: "action tidak dikenal" }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
