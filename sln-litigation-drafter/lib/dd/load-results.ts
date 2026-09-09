import { readBlobText } from "@/lib/blob";
import { ddKeys } from "@/lib/dd/blob-keys";
import { splitDocBlocks } from "@/lib/extract-format";
import { parseStoredJson, reconcileNarrative, validNarrativeClassification } from "@/lib/dd/narrative-coverage";
import type {
  DDClassifiedDoc, DDConsolidated, DDSubsectionAnalysis, DDEntityResult, DDExtractionRow, DDFinding, DDGapItem, DDTransaction,
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
    const [c, g, t, f, rep, nar, ana, extracted] = await Promise.all([
      readBlobText(ddKeys.classified(sessionId, e.id)),
      readBlobText(ddKeys.gaps(sessionId, e.id)),
      readBlobText(ddKeys.tables(sessionId, e.id)),
      readBlobText(ddKeys.findings(sessionId, e.id)),
      readBlobText(ddKeys.report(sessionId, e.id)),
      readBlobText(ddKeys.narrative(sessionId, e.id)),
      readBlobText(ddKeys.analyses(sessionId, e.id)),
      readBlobText(ddKeys.extracted(sessionId, e.id)),
    ]);
    const classifiedValue = parseStoredJson(c);
    const reportValue = parseStoredJson(rep);
    // Existing report renderers expect a file array. Preserve malformed metadata
    // as uncertainty in narrative accounting, rather than casting it into a report.
    const safeReport = reportValue && typeof reportValue === "object" && !Array.isArray(reportValue) &&
      "files" in reportValue && Array.isArray(reportValue.files) && reportValue.files.every((file: unknown) =>
        file && typeof file === "object" && "name" in file && typeof file.name === "string" &&
        "status" in file && ["selesai", "gagal", "perlu_ocr"].includes(String(file.status)))
      ? reportValue as ExtractReport : null;
    results.push({
      entity: e,
      classified: validNarrativeClassification(classifiedValue, e.id) ? classifiedValue as DDClassifiedDoc[] : [],
      gaps: g ? (JSON.parse(g) as DDGapItem[]) : [],
      rows: t ? (JSON.parse(t) as DDExtractionRow[]) : [],
      findings: f ? (JSON.parse(f) as DDFinding[]) : [],
      extractReport: safeReport,
      // Optional stage: absent narrative simply means Bagian I falls back to the
      // completeness table, so an older session still exports.
      narrative: reconcileNarrative(parseStoredJson(nar), {
        entityId: e.id, entityName: e.name, classified: classifiedValue, extractReport: reportValue,
        contentByFile: new Map(splitDocBlocks(extracted ?? "").map((b) => [b.fileName, b.content])),
      }),
      analyses: ana ? (JSON.parse(ana) as DDSubsectionAnalysis[]) : [],
    });
  }
  const consRaw = await readBlobText(ddKeys.consolidated(sessionId));
  return { transaction, results, consolidated: consRaw ? (JSON.parse(consRaw) as DDConsolidated) : null };
}
