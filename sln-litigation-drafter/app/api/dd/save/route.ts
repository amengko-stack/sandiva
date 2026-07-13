import { NextRequest, NextResponse } from "next/server";
import { isValidSessionId } from "@/lib/blob";
import { writeMatterFile } from "@/lib/graph-client";
import { verifyDocx } from "@/lib/docx-verify";
import { loadEntityResults } from "@/lib/dd/load-results";
import { buildDdReportDocx } from "@/lib/dd/dd-docx-builder";
import { buildDdWorkbook } from "@/lib/dd/dd-excel-builder";

export const maxDuration = 300;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function POST(req: NextRequest) {
  try {
    const { sessionId, folderPath } = (await req.json()) as { sessionId: string; folderPath: string };
    if (!isValidSessionId(sessionId) || !folderPath?.trim()) {
      return NextResponse.json({ error: "sessionId/folderPath tidak valid" }, { status: 400 });
    }
    const data = await loadEntityResults(sessionId);
    const slug = data.transaction.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
    const date = new Date().toISOString().slice(0, 10);

    const docxBuf = await buildDdReportDocx(data);
    const verdict = verifyDocx(docxBuf);
    if (verdict.bad > 0 || verdict.illegal > 0) {
      return NextResponse.json({ error: "Dokumen Word tidak lolos verifikasi integritas — tidak disimpan." }, { status: 500 });
    }
    const xlsxBuf = await buildDdWorkbook(data);

    const docxName = `AI/LDD_Temuan_${slug}_${date}.docx`;
    const xlsxName = `AI/LDD_Matriks_${slug}_${date}.xlsx`;
    await writeMatterFile(folderPath.trim(), docxName, docxBuf, DOCX_MIME);
    await writeMatterFile(folderPath.trim(), xlsxName, xlsxBuf, XLSX_MIME);

    return NextResponse.json({ ok: true, files: [docxName, xlsxName] });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
