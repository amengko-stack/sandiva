import { NextRequest, NextResponse } from "next/server";
import PDFDocument from "pdfkit";
import { readBlobText } from "@/lib/blob";
import type { ExtractReport } from "@/types";
import { PRACTICE_AREAS } from "@/config/documentTypes";

export const maxDuration = 30;

const CATEGORY_LABELS: Record<string, string> = {
  KRITIS:    "KRITIS",
  PENDUKUNG: "PENDUKUNG",
  REFERENSI: "REFERENSI",
};

const DOC_TYPE_LABELS: Record<string, string> = {
  perjanjian_kontrak: "Perjanjian/Kontrak",
  putusan_penetapan:  "Putusan/Penetapan",
  surat_menyurat:     "Surat Menyurat",
  bukti_transaksi:    "Bukti Transaksi",
  dokumen_korporasi:  "Dokumen Korporasi",
  tidak_dikenali:     "Tidak Dikenali",
};

function resolveDocTypeLabel(docTypeId: string, practiceAreaId: string | null): string {
  for (const area of PRACTICE_AREAS) {
    if (!practiceAreaId || area.id === practiceAreaId) {
      const dt = area.docTypes.find((d) => d.id === docTypeId);
      if (dt) return dt.label;
    }
  }
  return docTypeId;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("id-ID", {
      day: "2-digit", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta",
    }) + " WIB";
  } catch {
    return iso;
  }
}

function formatChars(n?: number): string {
  if (!n) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

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

  // Generate PDF
  const chunks: Buffer[] = [];
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  await new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);

    const pageWidth = doc.page.width - 100; // account for margins

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(18).font("Helvetica-Bold").fillColor("#1a2b4a")
      .text("SANDIVA LEGAL NETWORK", 50, 50);
    doc.fontSize(10).font("Helvetica").fillColor("#555")
      .text("Inventaris Dokumen — Rekam Jejak Analisis AI", 50, 75);

    doc.moveTo(50, 95).lineTo(doc.page.width - 50, 95).strokeColor("#c8a84b").lineWidth(2).stroke();

    // ── Meta table ───────────────────────────────────────────────────────────
    let y = 110;
    const col1 = 50, col2 = 200;

    function metaRow(label: string, value: string) {
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#555").text(label, col1, y);
      doc.fontSize(9).font("Helvetica").fillColor("#222").text(value || "—", col2, y, { width: pageWidth - (col2 - col1) });
      y += 16;
    }

    metaRow("Folder Matter",   report.folderPath || "—");
    metaRow("Jenis Dokumen",   resolveDocTypeLabel(report.docTypeId, report.practiceAreaId) || "—");
    metaRow("Jenis Klaim",     report.claimType || "—");
    metaRow("Nomor Referensi", report.ref || "—");
    metaRow("Waktu Ekstraksi", formatTimestamp(report.timestamp));
    metaRow("Session ID",      report.sessionId);

    y += 8;
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor("#ddd").lineWidth(0.5).stroke();
    y += 14;

    // ── Documents by category ────────────────────────────────────────────────
    const CATEGORY_ORDER = ["KRITIS", "PENDUKUNG", "REFERENSI"] as const;
    const CATEGORY_COLORS: Record<string, string> = {
      KRITIS: "#c0392b", PENDUKUNG: "#d35400", REFERENSI: "#5a7fa0",
    };

    const succeeded = report.files.filter((f) => f.status === "selesai");
    const failed    = report.files.filter((f) => f.status === "gagal");

    for (const cat of CATEGORY_ORDER) {
      const group = succeeded.filter((f) => f.category === cat);
      if (group.length === 0) continue;

      // Check if we need a new page
      if (y > 680) { doc.addPage(); y = 50; }

      doc.fontSize(10).font("Helvetica-Bold").fillColor(CATEGORY_COLORS[cat])
        .text(CATEGORY_LABELS[cat], 50, y);
      y += 14;

      // Column headers
      doc.fontSize(8).font("Helvetica-Bold").fillColor("#888")
        .text("Nama File", 50, y, { width: 230 })
        .text("Jenis Dokumen", 285, y, { width: 120 })
        .text("Metode Ekstraksi", 410, y, { width: 110 })
        .text("Karakter", 525, y, { width: 60 });
      y += 12;
      doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor("#eee").lineWidth(0.5).stroke();
      y += 4;

      for (const f of group) {
        if (y > 720) { doc.addPage(); y = 50; }
        const rowColor = "#222";
        doc.fontSize(8).font("Helvetica").fillColor(rowColor)
          .text(f.name, 50, y, { width: 230, ellipsis: true })
          .text(DOC_TYPE_LABELS[f.documentType] ?? f.documentType, 285, y, { width: 120 })
          .text(f.extractionMode, 410, y, { width: 110 })
          .text(formatChars(f.charCount), 525, y, { width: 60 });
        y += 14;
      }
      y += 6;
    }

    // ── Failed documents ─────────────────────────────────────────────────────
    if (failed.length > 0) {
      if (y > 660) { doc.addPage(); y = 50; }

      doc.fontSize(10).font("Helvetica-Bold").fillColor("#c0392b").text("GAGAL DIEKSTRAK", 50, y);
      y += 14;

      doc.fontSize(8).font("Helvetica-Bold").fillColor("#888")
        .text("Nama File", 50, y, { width: 280 })
        .text("Alasan", 335, y, { width: 255 });
      y += 12;
      doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor("#eee").lineWidth(0.5).stroke();
      y += 4;

      for (const f of failed) {
        if (y > 720) { doc.addPage(); y = 50; }
        doc.fontSize(8).font("Helvetica").fillColor("#555")
          .text(f.name, 50, y, { width: 280, ellipsis: true })
          .text(f.reason ?? "—", 335, y, { width: 255 });
        y += 14;
      }
      y += 6;
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    if (y > 680) { doc.addPage(); y = 50; }

    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor("#ddd").lineWidth(0.5).stroke();
    y += 14;

    doc.fontSize(10).font("Helvetica-Bold").fillColor("#1a2b4a").text("RINGKASAN", 50, y);
    y += 14;

    const summaryItems = [
      ["Total dokumen dipilih", String(report.files.length)],
      ["Berhasil diekstrak", String(report.processed)],
      ["Gagal diekstrak", String(report.skipped)],
      ["Total karakter diekstrak", `${(report.totalChars / 1000).toFixed(1)}k`],
      ...CATEGORY_ORDER.map((cat) => [
        `  — ${CATEGORY_LABELS[cat]}`,
        String(succeeded.filter((f) => f.category === cat).length) + " dokumen",
      ]),
    ];

    for (const [label, value] of summaryItems) {
      if (y > 720) { doc.addPage(); y = 50; }
      doc.fontSize(9).font("Helvetica").fillColor("#444").text(label, 50, y, { width: 250 });
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#222").text(value, 305, y);
      y += 14;
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    const pageCount = (doc.bufferedPageRange().count);
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).font("Helvetica").fillColor("#aaa")
        .text(
          `Dihasilkan oleh SLN Litigation Drafter  ·  ${formatTimestamp(report.timestamp)}  ·  Halaman ${i + 1} dari ${pageCount}`,
          50, doc.page.height - 35, { align: "center", width: pageWidth }
        );
    }

    doc.end();
  });

  const pdfBuffer = Buffer.concat(chunks);
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
