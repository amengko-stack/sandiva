import { NextRequest, NextResponse } from "next/server";
import { isValidSessionId } from "@/lib/blob";
import { loadEntityResults } from "@/lib/dd/load-results";
import { readBaselines, recordBaseline } from "@/lib/dd/baseline-store";

export const maxDuration = 60;

/**
 * Records what an issued report covered, so a later supplement can say what
 * changed.
 *
 * A POST rather than a side effect of the Word export: the export is a GET that a
 * browser or a link prefetch may fire more than once, and "this report was issued"
 * is a decision, not a download. The lawyer takes it explicitly.
 */
export async function POST(req: NextRequest) {
  try {
    const { sessionId } = (await req.json()) as { sessionId: string };
    if (!isValidSessionId(sessionId)) {
      return NextResponse.json({ error: "sessionId tidak valid" }, { status: 400 });
    }
    const { transaction, results } = await loadEntityResults(sessionId);
    // results.length proves nothing: loadEntityResults returns one entry per
    // transaction entity whether or not anything has been classified, so an
    // untouched session would otherwise be recorded as an issued report — and a
    // supplement would later be diffed against a report that never existed. What
    // makes a report a report is documents actually examined.
    const empty = results.filter((r) => r.classified.length === 0).map((r) => r.entity.name);
    if (empty.length === results.length) {
      return NextResponse.json(
        { error: "Belum ada dokumen yang diklasifikasikan, sehingga belum ada laporan yang dapat dicatat sebagai diterbitkan." },
        { status: 400 }
      );
    }
    if (empty.length > 0) {
      return NextResponse.json(
        {
          error:
            `Entitas berikut belum memiliki dokumen yang diklasifikasikan: ${empty.join(", ")}. ` +
            `Selesaikan Tahap 3 untuk seluruh entitas sebelum mencatat penerbitan, agar dasar pembanding ` +
            `Laporan Tambahan mencerminkan laporan yang benar-benar diterbitkan.`,
        },
        { status: 400 }
      );
    }
    // One clock reading for the whole transaction, so the entities of one issued
    // report share an issue timestamp instead of straddling a second boundary.
    const issuedAtISO = new Date().toISOString();
    const recorded = [];
    for (const result of results) {
      const r = await recordBaseline({
        sessionId,
        result,
        cutoffDateISO: transaction.cutoffDateISO,
        issuedAtISO,
      });
      recorded.push({
        entityId: result.entity.id,
        entityName: result.entity.name,
        recorded: r.recorded,
        total: r.total,
        documents: r.baseline.documents.length,
        outstanding: r.baseline.outstandingDocIds.length,
        findings: r.baseline.findings.length,
      });
    }
    return NextResponse.json({ issuedAtISO, entities: recorded });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}

/** What has been recorded so far, so the UI can show whether a supplement is possible. */
export async function GET(req: NextRequest) {
  try {
    const sessionId = new URL(req.url).searchParams.get("sessionId");
    if (!isValidSessionId(sessionId)) {
      return NextResponse.json({ error: "sessionId tidak valid" }, { status: 400 });
    }
    const { transaction } = await loadEntityResults(sessionId);
    const entities = [];
    for (const e of transaction.entities) {
      const list = await readBaselines(sessionId, e.id);
      entities.push({
        entityId: e.id,
        entityName: e.name,
        count: list.length,
        lastIssuedAtISO: list.length > 0 ? list[list.length - 1].issuedAtISO : null,
      });
    }
    return NextResponse.json({ entities });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
