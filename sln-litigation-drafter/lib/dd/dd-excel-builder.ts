import ExcelJS from "exceljs";
import { aspectLabel } from "@/config/ddAspects";
import { transactionLabel } from "@/config/ddTransactionTypes";
import { sectionForAspect } from "@/config/ddReportSections";
import type { DDConsolidated, DDEntityResult, DDGapItem, DDTransaction } from "@/types/dd";

const REPORT_SECTION_LABEL_CROSS_ENTITY = "— (temuan konsolidasi/lintas entitas)";

function reportSectionLabel(aspectId: DDEntityResult["findings"][number]["aspectId"]): string {
  if (aspectId === null) return REPORT_SECTION_LABEL_CROSS_ENTITY;
  const section = sectionForAspect(aspectId);
  return `${section.numeral} — ${section.title}`;
}

const GAP_LABEL: Record<DDGapItem["status"], string> = {
  present: "Ada", incomplete: "Tidak lengkap", expired: "Kedaluwarsa",
  missing: "TIDAK ADA", not_applicable: "N/A",
};
const GAP_FILL: Record<DDGapItem["status"], string> = {
  present: "FFD1FAE5", incomplete: "FFFEF3C7", expired: "FFFED7AA",
  missing: "FFFEE2E2", not_applicable: "FFE5E7EB",
};

function headerRow(ws: ExcelJS.Worksheet, values: string[]) {
  const row = ws.addRow(values);
  row.font = { bold: true };
  return row;
}

export async function buildDdWorkbook(args: {
  transaction: DDTransaction;
  results: DDEntityResult[];
  consolidated: DDConsolidated | null;
}): Promise<Buffer> {
  const { transaction, results, consolidated } = args;
  const wb = new ExcelJS.Workbook();
  wb.creator = "SLN Due Diligence";

  // --- Indeks Dokumen ---
  const idx = wb.addWorksheet("Indeks Dokumen");
  headerRow(idx, ["Entitas", "Aspek", "Item Checklist", "File", "Judul", "Tanggal", "Para Pihak", "Ringkasan", "Keyakinan"]);
  for (const r of results) {
    for (const c of r.classified) {
      idx.addRow([
        r.entity.name, aspectLabel(c.aspectId), c.expectedDocId ?? "—", c.fileName,
        c.docLabel, c.docDate ?? "—", c.parties.join(", "), c.summary, c.confidence,
      ]);
    }
  }
  idx.columns.forEach((col) => { col.width = 22; });

  // --- Matriks Gap (client document-request list) ---
  const gap = wb.addWorksheet("Matriks Gap");
  headerRow(gap, ["Dokumen yang Diharapkan", "Aspek", ...results.map((r) => r.entity.name), "Keterangan"]);
  const allExpected = new Map<string, { label: string; aspectId: DDGapItem["aspectId"] }>();
  for (const r of results) for (const g of r.gaps) allExpected.set(g.expectedDocId, { label: g.expectedLabel, aspectId: g.aspectId });
  for (const [docId, meta] of Array.from(allExpected.entries())) {
    const cells: (string | undefined)[] = [];
    const notes: string[] = [];
    for (const r of results) {
      const g = r.gaps.find((x) => x.expectedDocId === docId);
      cells.push(g ? GAP_LABEL[g.status] : undefined);
      if (g?.note) notes.push(`${r.entity.name}: ${g.note}`);
    }
    const row = gap.addRow([meta.label, aspectLabel(meta.aspectId), ...cells, notes.join(" | ")]);
    results.forEach((r, i) => {
      const g = r.gaps.find((x) => x.expectedDocId === docId);
      if (g) {
        row.getCell(3 + i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GAP_FILL[g.status] } };
      }
    });
  }
  gap.columns.forEach((col) => { col.width = 26; });

  // --- Ketentuan Kunci ---
  const terms = wb.addWorksheet("Ketentuan Kunci");
  const fieldIds: string[] = [];
  for (const r of results) for (const row of r.rows) for (const c of row.cells) {
    if (!fieldIds.includes(c.fieldId)) fieldIds.push(c.fieldId);
  }
  headerRow(terms, ["Entitas", "Perjanjian", "File", ...fieldIds.map((f) => f.replace(/_/g, " ")), "Kutipan"]);
  for (const r of results) {
    for (const row of r.rows) {
      const quotes: string[] = [];
      const values = fieldIds.map((fid) => {
        const c = row.cells.find((x) => x.fieldId === fid);
        if (!c) return "·";
        if (c.verbatim) quotes.push(`${fid}: "${c.verbatim}"`);
        return c.dealTriggered ? `⚠ ${c.value}` : c.value;
      });
      terms.addRow([r.entity.name, row.agreementLabel, row.memberFiles.join("; "), ...values, quotes.join("\n")]);
    }
  }
  terms.columns.forEach((col) => { col.width = 24; });

  // --- Temuan ---
  const temuan = wb.addWorksheet("Temuan");
  headerRow(temuan, ["Entitas", "Aspek", "Bagian Laporan", "Dimensi", "Severitas", "Status Review", "Temuan", "Dampak", "Tindak Lanjut", "Sumber", "Kutipan", "Keberlakuan"]);
  const allFindings = [
    ...results.flatMap((r) => r.findings.map((f) => ({ f, entityName: r.entity.name }))),
    ...(consolidated?.crossEntityFindings ?? []).map((f) => ({ f, entityName: "KONSOLIDASI" })),
  ];
  for (const { f, entityName } of allFindings) {
    temuan.addRow([
      entityName, f.aspectId ? aspectLabel(f.aspectId) : "—", reportSectionLabel(f.aspectId), f.dimension, f.severity, f.status,
      f.editedProblem ?? f.problem, f.whyItMatters, f.suggestedFix,
      f.sourceFile ?? "—", f.anchor, f.currencyStatus ?? "—",
    ]);
  }
  temuan.columns.forEach((col) => { col.width = 24; });

  // --- Ringkasan ---
  const sum = wb.addWorksheet("Ringkasan");
  sum.addRow([`Uji Tuntas: ${transaction.name}`]).font = { bold: true, size: 14 };
  sum.addRow([`Transaksi: ${transactionLabel(transaction.type)} — per ${transaction.cutoffDateISO}`]);
  sum.addRow([]);
  headerRow(sum, ["Aspek", "Total", "Ada", "Tidak Ada", "Tidak Lengkap", "Kedaluwarsa", "N/A"]);
  for (const r of consolidated?.aspectRollup ?? []) {
    sum.addRow([aspectLabel(r.aspectId), r.totalExpected, r.present, r.missing, r.incomplete, r.expired, r.notApplicable]);
  }
  sum.addRow([]);
  const bySev = { kritis: 0, material: 0, minor: 0 };
  for (const { f } of allFindings) if (f.status !== "dismissed") bySev[f.severity]++;
  sum.addRow(["Temuan (tidak termasuk yang ditolak):", `kritis ${bySev.kritis}`, `material ${bySev.material}`, `minor ${bySev.minor}`]);
  sum.columns.forEach((col) => { col.width = 22; });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
