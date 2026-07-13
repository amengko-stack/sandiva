import {
  AlignmentType, Document, Footer, Header, HeadingLevel, PageNumber, Packer,
  Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import { aspectLabel } from "@/config/ddAspects";
import { transactionLabel } from "@/config/ddTransactionTypes";
import type { DDConsolidated, DDEntityResult, DDFinding, DDGapItem, DDTransaction } from "@/types/dd";

// Same defect class lib/docx-builder.ts guards against — control chars corrupt Word XML.
// Kept local so the litigation builder stays untouched.
function sanitizeForXml(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, "");
}

const FONT = "Calibri Light";
const t = (text: string, opts: { bold?: boolean; color?: string; size?: number } = {}) =>
  new TextRun({ text: sanitizeForXml(text), font: FONT, size: opts.size ?? 22, bold: opts.bold, color: opts.color });

const p = (text: string, opts: { bold?: boolean; color?: string; heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel] } = {}) =>
  new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    heading: opts.heading,
    children: [t(text, opts)],
  });

const cell = (text: string, opts: { bold?: boolean; fill?: string } = {}) =>
  new TableCell({
    shading: opts.fill ? { fill: opts.fill } : undefined,
    children: [new Paragraph({ children: [t(text, { bold: opts.bold, size: 20 })] })],
  });

const GAP_LABEL: Record<DDGapItem["status"], string> = {
  present: "Ada", incomplete: "Tidak lengkap", expired: "Kedaluwarsa",
  missing: "TIDAK ADA", not_applicable: "N/A",
};
const GAP_FILL: Record<DDGapItem["status"], string> = {
  present: "D1FAE5", incomplete: "FEF3C7", expired: "FED7AA", missing: "FEE2E2", not_applicable: "E5E7EB",
};
const SEV_ORDER: DDFinding["severity"][] = ["kritis", "material", "minor"];

function findingParas(f: DDFinding): Paragraph[] {
  const out = [
    new Paragraph({
      children: [
        t(`[${f.severity.toUpperCase()}] `, { bold: true, color: f.severity === "kritis" ? "B91C1C" : f.severity === "material" ? "B45309" : "374151" }),
        t(f.editedProblem ?? f.problem, { bold: true }),
        ...(f.verified ? [t("  ✓ terverifikasi", { color: "059669" })] : []),
      ],
    }),
    p(`Dampak: ${f.whyItMatters}`),
    p(`Tindak lanjut: ${f.suggestedFix}`),
  ];
  if (f.sourceFile && f.anchor) out.push(p(`Sumber: ${f.sourceFile} — "${f.anchor}"`));
  if (f.currencyStatus === "superseded" && f.currencyNote) {
    out.push(new Paragraph({ children: [t(`⚠ Peraturan diganti/diubah: ${f.currencyNote}`, { bold: true, color: "C2410C" })] }));
  }
  out.push(p(""));
  return out;
}

export async function buildDdReportDocx(args: {
  transaction: DDTransaction;
  results: DDEntityResult[];
  consolidated: DDConsolidated | null;
}): Promise<Buffer> {
  const { transaction, results, consolidated } = args;
  const children: (Paragraph | Table)[] = [];

  // --- Cover ---
  children.push(
    p("LAPORAN TEMUAN UJI TUNTAS", { heading: HeadingLevel.TITLE }),
    p(transaction.name, { heading: HeadingLevel.HEADING_1 }),
    p(`Transaksi: ${transactionLabel(transaction.type)} — klien sebagai ${transaction.clientRole}`),
    p(`Tanggal uji (cut-off): ${transaction.cutoffDateISO}`),
    p("Dokumen kerja temuan & gap — bukan Laporan Uji Tuntas final. Disusun dengan bantuan AI dan telah/harus ditelaah oleh advokat penanggung jawab.", { bold: true }),
    p("")
  );

  // --- Ringkasan Eksekutif ---
  children.push(p("RINGKASAN EKSEKUTIF", { heading: HeadingLevel.HEADING_1 }));
  const bySev = { kritis: 0, material: 0, minor: 0 };
  for (const r of results) for (const f of r.findings) if (f.status !== "dismissed") bySev[f.severity]++;
  for (const f of consolidated?.crossEntityFindings ?? []) if (f.status !== "dismissed") bySev[f.severity]++;
  children.push(p(`Temuan: ${bySev.kritis} kritis, ${bySev.material} material, ${bySev.minor} minor (tidak termasuk yang ditolak reviewer).`));
  for (const r of results) {
    const rep = r.extractReport;
    const cov = rep ? `${rep.processed}/${rep.files.length} dokumen diekstrak${rep.ocrRequired ? `, ${rep.ocrRequired} perlu OCR` : ""}${rep.skipped ? `, ${rep.skipped} gagal` : ""}` : "cakupan ekstraksi tidak tersedia";
    children.push(p(`${r.entity.name} (${r.entity.role}) — ${cov}.`));
  }
  children.push(p(""));

  // --- Per entity ---
  for (const r of results) {
    children.push(p(r.entity.name.toUpperCase(), { heading: HeadingLevel.HEADING_1 }));

    children.push(p("Status Kelengkapan Dokumen", { heading: HeadingLevel.HEADING_2 }));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [cell("Aspek", { bold: true }), cell("Dokumen", { bold: true }), cell("Status", { bold: true }), cell("Keterangan", { bold: true })] }),
        ...r.gaps.map((g) => new TableRow({
          children: [
            cell(aspectLabel(g.aspectId)), cell(g.expectedLabel),
            cell(GAP_LABEL[g.status], { fill: GAP_FILL[g.status] }),
            cell(g.matchedFiles.length ? g.matchedFiles.join(", ") : g.note),
          ],
        })),
      ],
    }));
    children.push(p(""));

    if (r.rows.length > 0) {
      children.push(p("Ketentuan Kunci Perjanjian", { heading: HeadingLevel.HEADING_2 }));
      for (const row of r.rows) {
        children.push(p(row.agreementLabel, { heading: HeadingLevel.HEADING_3 }));
        if (row.memberFiles.length > 1) children.push(p(`(${row.memberFiles.length} file: perjanjian induk + addendum)`));
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [cell("Ketentuan", { bold: true }), cell("Isi", { bold: true }), cell("Kutipan", { bold: true })] }),
            ...row.cells.map((c) => new TableRow({
              children: [
                cell(c.fieldId.replace(/_/g, " ")),
                cell(`${c.dealTriggered ? "⚠ " : ""}${c.value}`, c.dealTriggered ? { fill: "FEE2E2" } : {}),
                cell(c.verbatim || "—"),
              ],
            })),
          ],
        }));
        children.push(p(""));
      }
    }

    children.push(p("Temuan", { heading: HeadingLevel.HEADING_2 }));
    const active = r.findings.filter((f) => f.status !== "dismissed");
    for (const sev of SEV_ORDER) {
      for (const f of active.filter((x) => x.severity === sev)) children.push(...findingParas(f));
    }
    if (active.length === 0) children.push(p("Tidak ada temuan aktif untuk entitas ini."));
  }

  // --- Konsolidasi ---
  if (consolidated) {
    children.push(p("KONSOLIDASI LINTAS-ENTITAS", { heading: HeadingLevel.HEADING_1 }));
    const activeCross = consolidated.crossEntityFindings.filter((x) => x.status !== "dismissed");
    for (const f of activeCross) children.push(...findingParas(f));
    if (activeCross.length === 0) children.push(p("Tidak ada temuan lintas-entitas."));
    children.push(p("Rekap Kelengkapan per Aspek", { heading: HeadingLevel.HEADING_2 }));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: ["Aspek", "Total", "Ada", "Tidak Ada", "Tidak Lengkap", "Kedaluwarsa", "N/A"].map((h) => cell(h, { bold: true })) }),
        ...consolidated.aspectRollup.map((a) => new TableRow({
          children: [
            cell(aspectLabel(a.aspectId)), cell(String(a.totalExpected)), cell(String(a.present)),
            cell(String(a.missing)), cell(String(a.incomplete)), cell(String(a.expired)), cell(String(a.notApplicable)),
          ],
        })),
      ],
    }));
  }

  // --- Metodologi ---
  children.push(
    p(""),
    p("METODOLOGI & BATASAN", { heading: HeadingLevel.HEADING_1 }),
    p("Dokumen data room diekstrak dan dianalisis dengan bantuan AI; setiap temuan berlabuh pada kutipan dokumen sumber dan telah melalui verifikasi adversarial untuk temuan kritis. Status review (diterima/ditolak/diedit) mencerminkan telaah advokat."),
    p("Keberlakuan peraturan diperiksa secara otomatis dan dapat berubah — VERIFIKASI KEBERLAKUAN PERATURAN SEBELUM DIANDALKAN.", { bold: true }),
    p(`Dibuat: ${new Date().toISOString()}`)
  );

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{
      headers: { default: new Header({ children: [p(`Uji Tuntas — ${transaction.name}`)] }) },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18 })],
          })],
        }),
      },
      children,
    }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
