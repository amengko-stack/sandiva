import { authorizeLitigation, litigationDenied, LitigationScopeError } from "@/lib/litigation-session";
import { NextRequest, NextResponse } from "next/server";
import { readBlobText } from "@/lib/blob";
import { generateInventoryPdf } from "@/lib/inventory-pdf";
import { writeMatterFile } from "@/lib/litigation-sharepoint";
import type { ExtractReport } from "@/types";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, folderPath } = (await req.json()) as {
      sessionId: string;
      folderPath: string;
    };

    const registration = await authorizeLitigation(sessionId, { root: folderPath });

    const raw = await readBlobText(`sessions/${sessionId}/report.json`);
    if (!raw) {
      return NextResponse.json({ error: "Laporan tidak ditemukan untuk sesi ini" }, { status: 404 });
    }

    let report: ExtractReport;
    try {
      report = JSON.parse(raw) as ExtractReport;
    } catch {
      return NextResponse.json({ error: "Format laporan tidak valid" }, { status: 500 });
    }

    console.log(`[inventory-save] report shape: files=${report.files?.length} totalChars=${report.totalChars} processed=${report.processed} skipped=${report.skipped}`);

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await generateInventoryPdf(report);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[inventory-save] pdf-gen failed:", message, e instanceof Error ? e.stack : "");
      return NextResponse.json({ error: `Gagal membuat PDF inventaris: ${message}` }, { status: 500 });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // writeMatterFile resolves folderPath (a sharing link) to the matter's own
    // drive and auto-creates the AI/ folder. The subfolder is part of the filename.
    let webUrl: string;
    try {
      webUrl = await writeMatterFile(registration, `AI/document_inventory_${timestamp}.pdf`, pdfBuffer, "application/pdf");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[inventory-save] sharepoint write failed:", message, e instanceof Error ? e.stack : "");
      return NextResponse.json({ error: `Gagal menyimpan ke SharePoint: ${message}` }, { status: 500 });
    }

    return NextResponse.json({ ok: true, webUrl });
  } catch (e: unknown) {
    if (e instanceof LitigationScopeError) return litigationDenied();
    const message = e instanceof Error ? e.message : "Gagal menyimpan inventaris";
    console.error("[inventory-save] Error:", message, e instanceof Error ? e.stack : "");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
