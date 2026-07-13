import { readBlobText } from "@/lib/blob";
import { ddKeys } from "@/lib/dd/blob-keys";
import type {
  DDClassifiedDoc, DDConsolidated, DDEntityResult, DDExtractionRow, DDFinding, DDGapItem, DDTransaction,
} from "@/types/dd";
import type { ExtractReport } from "@/types";

export async function loadEntityResults(sessionId: string): Promise<{
  transaction: DDTransaction; results: DDEntityResult[]; consolidated: DDConsolidated | null;
}> {
  const txnRaw = await readBlobText(ddKeys.transaction(sessionId));
  if (!txnRaw) throw new Error("transaction.json tidak ditemukan — sesi kedaluwarsa atau Stage 1 belum selesai.");
  const transaction = JSON.parse(txnRaw) as DDTransaction;

  const results: DDEntityResult[] = [];
  for (const e of transaction.entities) {
    const [c, g, t, f, rep] = await Promise.all([
      readBlobText(ddKeys.classified(sessionId, e.id)),
      readBlobText(ddKeys.gaps(sessionId, e.id)),
      readBlobText(ddKeys.tables(sessionId, e.id)),
      readBlobText(ddKeys.findings(sessionId, e.id)),
      readBlobText(ddKeys.report(sessionId, e.id)),
    ]);
    results.push({
      entity: e,
      classified: c ? (JSON.parse(c) as DDClassifiedDoc[]) : [],
      gaps: g ? (JSON.parse(g) as DDGapItem[]) : [],
      rows: t ? (JSON.parse(t) as DDExtractionRow[]) : [],
      findings: f ? (JSON.parse(f) as DDFinding[]) : [],
      extractReport: rep ? (JSON.parse(rep) as ExtractReport) : null,
    });
  }
  const consRaw = await readBlobText(ddKeys.consolidated(sessionId));
  return { transaction, results, consolidated: consRaw ? (JSON.parse(consRaw) as DDConsolidated) : null };
}
