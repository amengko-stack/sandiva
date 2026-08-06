import { NextRequest, NextResponse } from "next/server";
import { isValidSessionId } from "@/lib/blob";
import { isValidEntityId } from "@/lib/dd/blob-keys";
import { verifyDocx } from "@/lib/docx-verify";
import { loadEntityResults } from "@/lib/dd/load-results";
import { loadContentByFile, readBaselines } from "@/lib/dd/baseline-store";
import { diffAgainstBaseline } from "@/lib/dd/supplement";
import { buildSupplementDocx } from "@/lib/dd/dd-docx-builder";

export const maxDuration = 120;

/**
 * The SUPPLEMENT for one entity, diffed against the last report recorded as issued.
 *
 * Per entity rather than per transaction: a supplement states the cut-off of the
 * report it supplements, and different entities can have been issued at different
 * times, so one combined document would have to name several baselines and would
 * stop being readable as an addition to any one report.
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    const entityId = url.searchParams.get("entityId");
    if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
      return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
    }

    const { transaction, results } = await loadEntityResults(sessionId);
    const result = results.find((r) => r.entity.id === entityId);
    if (!result) return NextResponse.json({ error: "Entitas tidak dikenal." }, { status: 400 });

    const baselines = await readBaselines(sessionId, entityId);
    if (baselines.length === 0) {
      return NextResponse.json(
        {
          error:
            "Belum ada laporan yang tercatat diterbitkan untuk entitas ini, sehingga tidak ada dasar pembanding " +
            "bagi Laporan Tambahan. Catat penerbitan laporan terlebih dahulu pada Tahap 6.",
        },
        { status: 400 }
      );
    }

    const diff = diffAgainstBaseline(baselines[baselines.length - 1], {
      cutoffDateISO: transaction.cutoffDateISO,
      classified: result.classified,
      contentByFile: await loadContentByFile(sessionId, entityId),
      gaps: result.gaps,
      findings: result.findings,
    });

    // buildSupplementDocx throws with the reason when there is nothing to report or
    // the reliance scope is missing; both are the lawyer's to resolve, so the
    // message goes back verbatim rather than as a generic failure.
    const buf = await buildSupplementDocx({ transaction, entity: result.entity, diff });
    const verdict = verifyDocx(buf);
    if (verdict.bad > 0 || verdict.illegal > 0) {
      return NextResponse.json(
        { error: "Dokumen Word yang dihasilkan tidak lolos verifikasi integritas — tidak disajikan." },
        { status: 500 }
      );
    }
    const safe = result.entity.name.replace(/[^A-Za-z0-9_-]/g, "_");
    const name = `LDD_Supplement_${safe}_${new Date().toISOString().slice(0, 10)}.docx`;
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
