import { NextRequest, NextResponse } from "next/server";
import { readBlobText } from "@/lib/blob";
import { generateInventoryPdf } from "@/lib/inventory-pdf";
import type { ExtractReport } from "@/types";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json({ error: "sessionId wajib diisi" }, { status: 400 });
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
  const safeRef = (report.ref || "inventaris").replace(/\//g, "-").replace(/\s+/g, "_");
  const filename = `${safeRef}_inventaris_dokumen.pdf`;

  return new NextResponse(pdfBuffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": pdfBuffer.byteLength.toString(),
    },
  });
}
