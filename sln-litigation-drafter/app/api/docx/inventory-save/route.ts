import { NextRequest, NextResponse } from "next/server";
import { readBlobText } from "@/lib/blob";
import { generateInventoryPdf } from "@/lib/inventory-pdf";
import { uploadFileToSharePoint } from "@/lib/graph-client";
import type { ExtractReport } from "@/types";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, folderPath } = (await req.json()) as {
      sessionId: string;
      folderPath: string;
    };

    if (!sessionId || !folderPath) {
      return NextResponse.json({ error: "sessionId dan folderPath wajib diisi" }, { status: 400 });
    }

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

    const pdfBuffer = await generateInventoryPdf(report);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `document_inventory_${timestamp}.pdf`;
    const remotePath = `${folderPath.replace(/\/$/, "")}/AI/`;

    const webUrl = await uploadFileToSharePoint(remotePath, filename, pdfBuffer, "application/pdf");

    return NextResponse.json({ ok: true, webUrl });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menyimpan ke SharePoint";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
