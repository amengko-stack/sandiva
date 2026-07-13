import { NextRequest, NextResponse } from "next/server";
import { isValidSessionId } from "@/lib/blob";
import { verifyDocx } from "@/lib/docx-verify";
import { loadEntityResults } from "@/lib/dd/load-results";
import { buildDdReportDocx } from "@/lib/dd/dd-docx-builder";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  try {
    const sessionId = new URL(req.url).searchParams.get("sessionId");
    if (!isValidSessionId(sessionId)) {
      return NextResponse.json({ error: "sessionId tidak valid" }, { status: 400 });
    }
    const data = await loadEntityResults(sessionId);
    const buf = await buildDdReportDocx(data);
    const verdict = verifyDocx(buf);
    if (verdict.bad > 0 || verdict.illegal > 0) {
      return NextResponse.json({ error: "Dokumen Word yang dihasilkan tidak lolos verifikasi integritas — tidak disajikan." }, { status: 500 });
    }
    const name = `LDD_Temuan_${data.transaction.name.replace(/[^A-Za-z0-9_-]/g, "_")}_${new Date().toISOString().slice(0, 10)}.docx`;
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
