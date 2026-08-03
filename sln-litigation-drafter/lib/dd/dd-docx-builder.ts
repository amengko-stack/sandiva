import {
  AlignmentType, Document, Footer, Header, HeadingLevel, LevelFormat, PageBreak,
  PageNumber, Packer, Paragraph, Table, TableCell, TableOfContents, TableRow,
  TextRun, WidthType,
} from "docx";
import { aspectLabel } from "@/config/ddAspects";
import { transactionLabel } from "@/config/ddTransactionTypes";
import { planChapters, subNumber, type DDChapterPlan, type DDChapterSub } from "@/config/ddChapters";
import {
  confidentialityLegend, deriveVerdict, draftLegend, formatIndonesianDate, verdictLabel,
} from "@/lib/dd/report-boilerplate";
import { obligationsForLayer, resolveRegime, type DDObligation } from "@/lib/dd/regime";
import { renderNarrativeSectionI, type DDNarrativeBlock } from "@/lib/dd/narrative-render";
import { renderFindingsTable, renderVerdictLine } from "@/lib/dd/findings-render";
import { chapterDisclaimer, chapterPendahuluan } from "@/lib/dd/report-chapters";
import type {
  DDAspectId, DDConsolidated, DDEntity, DDEntityResult, DDFinding, DDGapItem, DDRegime,
  DDReportBlock, DDReportMeta, DDTransaction,
} from "@/types/dd";

// Same defect class lib/docx-builder.ts guards against — control chars corrupt Word XML.
// Kept local so the litigation builder stays untouched.
function sanitizeForXml(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, "");
}

// Firm house style, ported from SLN-LDD-Pipeline-v2/templates/build_docx.js.
const FONT = "Arial";
const BODY_SIZE = 22; // half-points => 11pt

const t = (
  text: string,
  opts: { bold?: boolean; italics?: boolean; color?: string; size?: number } = {}
) =>
  new TextRun({
    text: sanitizeForXml(text),
    font: FONT,
    size: opts.size ?? BODY_SIZE,
    bold: opts.bold,
    italics: opts.italics,
    color: opts.color,
  });

const p = (
  text: string,
  opts: {
    bold?: boolean;
    italics?: boolean;
    color?: string;
    size?: number;
    heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel];
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
    indent?: number;
  } = {}
) =>
  new Paragraph({
    alignment: opts.align ?? AlignmentType.JUSTIFIED,
    heading: opts.heading,
    spacing: { after: 120 },
    indent: opts.indent ? { left: opts.indent } : undefined,
    children: [t(text, opts)],
  });

const h1 = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [t(text, { bold: true, size: 32 })],
  });

const h2 = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
    children: [t(text, { bold: true, size: 26 })],
  });

const h3 = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [t(text, { bold: true, size: 24 })],
  });

const center = (
  text: string,
  opts: { bold?: boolean; italics?: boolean; size?: number; after?: number } = {}
) =>
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: opts.after ?? 120 },
    children: [t(text, { bold: opts.bold, italics: opts.italics, size: opts.size })],
  });

const labelled = (lbl: string, value: string) =>
  new Paragraph({
    spacing: { after: 60 },
    children: [t(lbl, { bold: true }), t(`  ${value}`)],
  });

const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

const cell = (text: string, opts: { bold?: boolean; fill?: string } = {}) =>
  new TableCell({
    shading: opts.fill ? { fill: opts.fill } : undefined,
    children: [new Paragraph({ children: [t(text, { bold: opts.bold, size: 20 })] })],
  });

function simpleTable(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map((hd) => cell(hd, { bold: true })) }),
      ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) })),
    ],
  });
}

/**
 * Renders the block union shared by narrative-render.ts and report-chapters.ts
 * (DDNarrativeBlock / DDReportBlock are structurally identical) into docx
 * elements: headings as H3, justified paragraphs, an indented italic
 * "Catatan:" for qualifications, bulleted lists, "label : value" defs, and
 * tables at full width with a bold header row.
 */
function renderBlocks(blocks: (DDNarrativeBlock | DDReportBlock)[]): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") {
      out.push(h3(b.text));
    } else if (b.kind === "para") {
      out.push(p(b.text));
    } else if (b.kind === "note") {
      out.push(
        new Paragraph({
          spacing: { before: 120, after: 60 },
          indent: { left: 720 },
          children: [t("Catatan:", { bold: true })],
        })
      );
      if (b.text) {
        out.push(
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: 120 },
            indent: { left: 720 },
            children: [t(b.text, { italics: true })],
          })
        );
      }
    } else if (b.kind === "list") {
      for (const item of b.items) {
        out.push(
          new Paragraph({
            numbering: { reference: "bullets", level: 0 },
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: 80 },
            indent: { left: 1080, hanging: 360 },
            children: [t(item)],
          })
        );
      }
    } else if (b.kind === "defs") {
      for (const [label, value] of b.rows) {
        out.push(
          new Paragraph({
            spacing: { after: 60 },
            indent: { left: 720 },
            children: [t(`${label} : `, { bold: true }), t(value)],
          })
        );
      }
    } else {
      out.push(simpleTable(b.headers, b.rows));
    }
  }
  return out;
}

const GAP_LABEL: Record<DDGapItem["status"], string> = {
  present: "Ada", incomplete: "Tidak lengkap", expired: "Kedaluwarsa",
  missing: "TIDAK ADA", not_applicable: "Tidak berlaku",
};
const GAP_FILL: Record<DDGapItem["status"], string> = {
  present: "D1FAE5", incomplete: "FEF3C7", expired: "FED7AA",
  missing: "FEE2E2", not_applicable: "E5E7EB",
};

const PLACEHOLDER_META: DDReportMeta = {
  matterRef: "[NOMOR REFERENSI]",
  clientName: "[NAMA KLIEN]",
  addressee: "[PENERIMA LAPORAN]",
  relianceScope: "[PIHAK YANG BERHAK MENGANDALKAN]",
  clientRelease: false,
  ddStartDateISO: "",
  taxInScope: false,
  assumptionsVariant: "ringkas",
  signatoryName: "[NAMA PENANDA TANGAN]",
  signatoryTitle: "[JABATAN]",
};

/** Obligation table for one layer, optionally filtered to a subset of ids. */
function obligationTable(obligations: DDObligation[]): Table {
  return simpleTable(
    ["Kewajiban", "Dasar hukum", "Jangka waktu / ambang"],
    obligations.map((ob) => [ob.label, ob.basis, ob.timing])
  );
}

function obligationNotes(obligations: DDObligation[]): Paragraph[] {
  const withNotes = obligations.filter((ob) => ob.note);
  if (withNotes.length === 0) return [];
  const out: Paragraph[] = [p("Catatan:", { bold: true })];
  for (const ob of withNotes) {
    out.push(
      new Paragraph({
        numbering: { reference: "bullets", level: 0 },
        spacing: { after: 80 },
        children: [t(`${ob.basis} — ${ob.note ?? ""}`)],
      })
    );
  }
  return out;
}

function byId(obligations: DDObligation[], ids: string[]): DDObligation[] {
  return obligations.filter((o) => ids.indexOf(o.id) !== -1);
}

/** Aspects an entity's checklist actually engaged, derived from gaps/classification. */
function presentAspectsFor(r: DDEntityResult): DDAspectId[] {
  const ids: DDAspectId[] = [];
  for (const g of r.gaps) ids.push(g.aspectId);
  for (const c of r.classified) ids.push(c.aspectId);
  for (const f of r.findings) if (f.aspectId) ids.push(f.aspectId);
  return Array.from(new Set(ids));
}

/** Coarse document-category summary for BAB 1.4, grouped by aspect. */
function docCategoriesFor(r: DDEntityResult): { category: string; period: string; status: string }[] {
  const byAspect = new Map<DDAspectId, number>();
  for (const c of r.classified) {
    byAspect.set(c.aspectId, (byAspect.get(c.aspectId) ?? 0) + 1);
  }
  return Array.from(byAspect.entries()).map(([aspectId, count]) => ({
    category: aspectLabel(aspectId),
    period: "—",
    status: `${count} dokumen diperiksa`,
  }));
}

/**
 * BAB II fix: narrative-render.ts hardcodes the "Status" definition row as
 * "Tertutup". Post-process the first "defs" block (the Data Korporasi block)
 * to reflect the entity's actual listing status, and append the parent row
 * when the entity sits under a Tbk ultimate parent.
 */
function fixStatusRow(
  blocks: DDNarrativeBlock[],
  entity: DDEntity,
  regime: DDRegime
): DDNarrativeBlock[] {
  const statusValue =
    entity.listingStatus === "tbk"
      ? "Perusahaan Terbuka (Tbk)"
      : "Perseroan Terbatas Tertutup (non-Tbk)";
  let fixed = false;
  return blocks.map((b) => {
    if (!fixed && b.kind === "defs") {
      const rows = b.rows.map((row): [string, string] => (row[0] === "Status" ? ["Status", statusValue] : row));
      if (regime.parentTbkName) {
        rows.push(["Induk utama", regime.parentTbkName]);
      }
      fixed = true;
      return { kind: "defs", rows };
    }
    return b;
  });
}

/** Findings belonging to a chapter's aspects, active (non-dismissed) only. */
function findingsForChapter(r: DDEntityResult, chapter: DDChapterPlan): DDFinding[] {
  const aspectSet = new Set(chapter.aspectIds);
  return r.findings.filter((f) => f.status !== "dismissed" && f.aspectId !== null && aspectSet.has(f.aspectId));
}

/** BAB for the transaction-specific chapter: framing paragraphs, then the UUPT obligation table. */
function renderTransaksiChapter(
  chNo: number, sub: DDChapterSub[], txnType: DDTransaction["type"], out: (Paragraph | Table)[]
): void {
  sub.forEach((s, i) => {
    out.push(h2(`${subNumber(chNo, i)} ${s.title}`));
    out.push(
      p(
        `Bagian ini menguraikan pemenuhan ketentuan Undang-Undang Perseroan Terbatas terkait ${s.title.toLowerCase()} ` +
          `sehubungan dengan rencana ${transactionLabel(txnType).toLowerCase()}.`
      )
    );
  });
  const obligations = obligationsForLayer("uupt", txnType);
  out.push(p("Kewajiban yang relevan berdasarkan Undang-Undang Perseroan Terbatas adalah sebagai berikut:"));
  out.push(obligationTable(obligations));
  for (const para of obligationNotes(obligations)) out.push(para);
}

/** BAB for the capital-markets chapter — content depends on whether the layer binds directly or via a parent. */
function renderPasarModalChapter(
  chNo: number, subs: DDChapterSub[], regime: DDRegime, entity: DDEntity,
  txnType: DDTransaction["type"], out: (Paragraph | Table)[]
): void {
  const viaParent = regime.parentTbkName !== null;
  const layer = viaParent ? "pasar_modal_induk" : "pasar_modal_langsung";
  const obligations = obligationsForLayer(layer, txnType);

  if (viaParent) {
    // 1: kedudukan
    out.push(h2(`${subNumber(chNo, 0)} ${subs[0].title}`));
    out.push(
      p(
        `${entity.name} bukan merupakan Perusahaan Terbuka dan karena itu tidak terikat secara langsung oleh ` +
          `peraturan Otoritas Jasa Keuangan. Namun demikian, induk utamanya, ${regime.parentTbkName}, berstatus ` +
          `Perusahaan Terbuka. POJK 17/POJK.04/2020 mencakup setiap transaksi yang dilakukan oleh Perusahaan ` +
          `Terbuka atau perusahaan terkendali, dengan ambang materialitas diukur terhadap angka induk. Karena itu ` +
          `transaksi atas saham atau aset ${entity.name} dapat merupakan Transaksi Material bagi ` +
          `${regime.parentTbkName}, dan kewajiban yang timbul melekat pada induk tersebut — bukan pada ${entity.name}.`
      )
    );
    // 2: pengujian ambang
    out.push(h2(`${subNumber(chNo, 1)} ${subs[1].title}`));
    out.push(
      p(
        `Angka keuangan induk berada di luar lingkup uji tuntas dari segi hukum. Hasil pengujian rasio di bawah ` +
          `ini hanya dapat dipastikan setelah data keuangan induk disediakan dan diverifikasi oleh pihak yang ` +
          `berkompeten; sepanjang data tersebut tidak tersedia, hasilnya ditandai ` +
          `"[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]".`
      )
    );
    out.push(
      simpleTable(
        ["Rasio yang diuji", "Ambang", "Hasil"],
        [
          ["Nilai transaksi terhadap ekuitas induk", "20% (10% dari total aset bila ekuitas induk negatif)",
            "[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]"],
          ["Total aset objek transaksi terhadap total aset induk", "20%",
            "[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]"],
          ["Laba bersih objek transaksi terhadap laba bersih induk", "20%",
            "[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]"],
          ["Pendapatan objek transaksi terhadap pendapatan induk", "20%",
            "[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]"],
        ]
      )
    );
    out.push(p("Dasar penghitungan adalah laporan keuangan triwulanan terakhir induk yang telah direviu atau diaudit."));
    // 3: kewajiban tingkat induk
    out.push(h2(`${subNumber(chNo, 2)} ${subs[2].title}`));
    const kewajiban = byId(obligations, ["induk.kewajiban_terpicu", "induk.pengecualian_99"]);
    out.push(obligationTable(kewajiban));
    for (const para of obligationNotes(kewajiban)) out.push(para);
    // 4: kedalaman rantai
    out.push(h2(`${subNumber(chNo, 3)} ${subs[3].title}`));
    const kedalaman = byId(obligations, ["induk.kedalaman_rantai"]);
    if (kedalaman.length > 0) {
      out.push(p(kedalaman[0].label));
      out.push(labelled("Catatan:", kedalaman[0].note ?? ""));
    }
  } else {
    out.push(h2(`${subNumber(chNo, 0)} ${subs[0].title}`));
    out.push(
      p(
        `${entity.name} berstatus Perusahaan Terbuka. Bagian ini menguji ambang Transaksi Material berdasarkan ` +
          `POJK 17/POJK.04/2020, diukur terhadap angka Perseroan sendiri.`
      )
    );
    const ambang = byId(obligations, [
      "pojk17.ambang", "pojk17.penilai", "pojk17.keterbukaan", "pojk17.rups", "pojk17.pengecualian", "pojk17.laporan_tahunan",
    ]);
    out.push(obligationTable(ambang));
    for (const para of obligationNotes(ambang)) out.push(para);

    out.push(h2(`${subNumber(chNo, 1)} ${subs[1].title}`));
    const afiliasi = byId(obligations, ["pojk42.afiliasi", "pojk42.benturan"]);
    out.push(p("Kewajiban yang timbul apabila transaksi mengandung unsur Transaksi Afiliasi atau Benturan Kepentingan:"));
    out.push(obligationTable(afiliasi));
    for (const para of obligationNotes(afiliasi)) out.push(para);

    out.push(h2(`${subNumber(chNo, 2)} ${subs[2].title}`));
    const ptw = byId(obligations, ["pojk9.ptw", "pojk9.pengumuman", "pojk9.refloat"]);
    out.push(p("Sepanjang transaksi mengakibatkan perubahan Pengendali, kewajiban berikut berlaku:"));
    out.push(obligationTable(ptw));
    for (const para of obligationNotes(ptw)) out.push(para);

    out.push(h2(`${subNumber(chNo, 3)} ${subs[3].title}`));
    out.push(
      p(
        `Selain kewajiban di atas, ${entity.name} tunduk pada kewajiban keterbukaan berkelanjutan berdasarkan ` +
          `peraturan Otoritas Jasa Keuangan dan peraturan Bursa Efek, termasuk pelaporan berkala dan keterbukaan ` +
          `informasi atau fakta material.`
      )
    );
  }
}

/** BAB for the analysis-per-aspect chapter: each sub-section carries its own analysis, findings, and verification. */
function renderAnalisisAspekChapter(
  chNo: number, chapter: DDChapterPlan, r: DDEntityResult, out: (Paragraph | Table)[]
): void {
  const chapterFindings = findingsForChapter(r, chapter);
  const analyses = r.analyses ?? [];
  const nonFindingsSubTitles = chapter.subs.filter((s) => !s.findings).map((s) => s.title);

  chapter.subs.forEach((sub, i) => {
    out.push(h2(`${subNumber(chNo, i)} ${sub.title}`));

    if (sub.findings) {
      const leftover = chapterFindings.filter(
        (f) => !f.subsectionTitle || nonFindingsSubTitles.indexOf(f.subsectionTitle) === -1
      );
      const blocks = renderFindingsTable(leftover);
      if (blocks.length === 0) {
        out.push(p("Tidak terdapat temuan tambahan yang belum diuraikan pada sub-bagian di atas."));
      } else {
        for (const el of renderBlocks(blocks)) out.push(el);
      }
      out.push(p(renderVerdictLine(chapterFindings), { bold: true }));
      return;
    }

    const analysis = analyses.find((a) => a.subsectionTitle === sub.title);
    if (!analysis) {
      out.push(
        p(
          `Sub-bagian "${sub.title}" belum dapat dianalisis berdasarkan Dokumen Yang Diperiksa dalam uji tuntas ini.`
        )
      );
      return;
    }

    for (const para of analysis.analysis) out.push(p(para));
    if (analysis.table) out.push(simpleTable(analysis.table.headers, analysis.table.rows));

    const subFindings = chapterFindings.filter((f) => f.subsectionTitle === sub.title);
    const findingBlocks = renderFindingsTable(subFindings);
    for (const el of renderBlocks(findingBlocks)) out.push(el);

    if (analysis.verification.length > 0) {
      out.push(p("Hal yang perlu diverifikasi:", { bold: true }));
      for (const item of analysis.verification) {
        out.push(
          new Paragraph({
            numbering: { reference: "bullets", level: 0 },
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: 80 },
            indent: { left: 1080, hanging: 360 },
            children: [t(item)],
          })
        );
      }
    }
  });
}

/** BAB Kesimpulan — 4 subs, computed from the entity's own analysis chapters and findings. */
function renderKesimpulanChapter(
  chNo: number, subs: DDChapterSub[], plan: DDChapterPlan[], r: DDEntityResult, out: (Paragraph | Table)[]
): void {
  const analysisChapters = plan.filter((c) => c.kind === "analisis_aspek");

  // 1: Ringkasan Temuan
  out.push(h2(`${subNumber(chNo, 0)} ${subs[0].title}`));
  const rows: string[][] = analysisChapters.map((c) => {
    const findings = findingsForChapter(r, c);
    const verdict = deriveVerdict(findings.map((f) => ({ severity: f.severity, status: f.status })));
    return [`${c.numeral}. ${c.title}`, verdictLabel(verdict), String(findings.length)];
  });
  out.push(simpleTable(["Bab", "Penilaian", "Jumlah Temuan"], rows));

  // 2: Penilaian Kepatuhan per Bab
  out.push(h2(`${subNumber(chNo, 1)} ${subs[1].title}`));
  const allActive = r.findings.filter((f) => f.status !== "dismissed");
  const overall = deriveVerdict(allActive.map((f) => ({ severity: f.severity, status: f.status })));
  out.push(
    p(
      `Sebagaimana dirinci pada tabel di atas, penilaian kepatuhan disusun per bab dengan tiga kemungkinan hasil: ` +
        `memenuhi ketentuan; memenuhi ketentuan dengan catatan; atau tidak memenuhi ketentuan. Secara keseluruhan, ` +
        `berdasarkan Dokumen Yang Diperiksa dan dengan memperhatikan seluruh asumsi dan pembatasan dalam Laporan ` +
        `ini, ${r.entity.name} ${verdictLabel(overall)}.`
    )
  );

  // 3: Hal yang Memerlukan Konfirmasi Lebih Lanjut
  out.push(h2(`${subNumber(chNo, 2)} ${subs[2].title}`));
  const needsVerification = allActive.filter(
    (f) =>
      (f.editedProblem ?? f.problem).indexOf("[PERLU VERIFIKASI]") !== -1 ||
      f.whyItMatters.indexOf("[PERLU VERIFIKASI]") !== -1 ||
      (f.legalConsequence ?? "").indexOf("[PERLU VERIFIKASI]") !== -1
  );
  if (needsVerification.length === 0) {
    out.push(p("Tidak terdapat hal yang secara khusus ditandai memerlukan konfirmasi lebih lanjut."));
  } else {
    for (const f of needsVerification) {
      out.push(
        new Paragraph({
          numbering: { reference: "numlist", level: 0 },
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 80 },
          indent: { left: 1080, hanging: 360 },
          children: [t(f.editedProblem ?? f.problem)],
        })
      );
    }
  }

  // 4: Rekomendasi Tindak Lanjut
  out.push(h2(`${subNumber(chNo, 3)} ${subs[3].title}`));
  if (allActive.length === 0) {
    out.push(p("Tidak terdapat rekomendasi tindak lanjut yang timbul dari uji tuntas ini."));
  } else {
    for (const f of allActive) {
      out.push(
        new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 80 },
          indent: { left: 1080, hanging: 360 },
          children: [t(f.suggestedFix)],
        })
      );
    }
  }
}

export async function buildDdReportDocx(args: {
  transaction: DDTransaction;
  results: DDEntityResult[];
  consolidated: DDConsolidated | null;
}): Promise<Buffer> {
  const { transaction, results, consolidated } = args;
  const meta = transaction.reportMeta ?? PLACEHOLDER_META;

  // Release gate, ported from build_docx.js: a report may not go out as a
  // client release without a defined reliance scope, because the reliance
  // clause would otherwise name nobody while the cover asserts the report is
  // releasable.
  if (meta.clientRelease && meta.relianceScope.trim() === "") {
    throw new Error(
      "Ekspor sebagai laporan final untuk klien diblokir: Ruang Lingkup Keterandalan (reliance scope) belum diisi pada Tahap 1. Isi kolom tersebut atau matikan opsi rilis ke klien."
    );
  }

  const children: (Paragraph | Table)[] = [];
  const primary = results.length > 0 ? results[0].entity : null;
  const cutoffLong = formatIndonesianDate(transaction.cutoffDateISO);

  // ---------------- Cover ----------------
  children.push(
    center("SANDIVA LEGAL NETWORK", { bold: true, size: 28, after: 240 }),
    center(confidentialityLegend(), { bold: true, size: 18, after: 720 }),
    center("LAPORAN UJI TUNTAS DARI SEGI HUKUM", { bold: true, size: 36, after: 120 }),
    center(`(${transactionLabel(transaction.type)})`, { bold: true, size: 26, after: 600 })
  );
  if (primary) {
    children.push(center(primary.name, { bold: true, size: 32, after: 720 }));
  }
  children.push(
    center(`Klien: ${meta.clientName}`, { after: 60 }),
    center(`Disampaikan kepada: ${meta.addressee}`, { after: 60 }),
    center(`Nomor Referensi: ${meta.matterRef}`, { after: 60 }),
    center(`Tanggal Akhir Uji Tuntas: ${cutoffLong}`, { after: 240 })
  );
  if (!meta.clientRelease) {
    children.push(
      center(draftLegend(), { bold: true, size: 24, after: 240 }),
      p(
        "Draf ini disusun untuk telaah internal dan belum dirilis kepada klien. Sebagian temuan bergantung pada " +
          "dokumen yang masih belum lengkap dan pada verifikasi yang belum dilakukan. Lihat Bab I.6 Asumsi dan " +
          "Pembatasan.",
        { italics: true }
      )
    );
  }
  children.push(
    p(
      "Laporan ini disusun dengan bantuan sistem kecerdasan artifisial dan wajib ditelaah serta disetujui oleh " +
        "advokat penanggung jawab sebelum diandalkan atau disampaikan kepada pihak mana pun.",
      { italics: true }
    ),
    pageBreak()
  );

  // ---------------- Daftar Isi ----------------
  children.push(
    h1("DAFTAR ISI"),
    // A Word TOC is a field: it renders EMPTY until the reader refreshes it, which
    // makes the report look as though it has no chapters at all. Say so on the
    // page rather than expecting the reader to know the shortcut.
    p(
      "Daftar isi di bawah ini akan terisi otomatis setelah dimuat ulang di Microsoft Word: tekan Ctrl+A lalu F9, " +
        "kemudian pilih \"Update entire table\". Seluruh bab tetap tersedia pada halaman-halaman berikutnya meskipun " +
        "daftar isi ini masih kosong.",
      { italics: true }
    ),
    new TableOfContents("Daftar Isi", { hyperlink: true, headingStyleRange: "1-3" }),
    pageBreak()
  );

  // ---------------- Per-entity chapters (BAB I..N, decimal sub-numbering) ----------------
  const multiEntity = results.length > 1;
  for (const r of results) {
    const regime = resolveRegime(r.entity);
    const plan = planChapters({
      transactionType: transaction.type,
      regime,
      presentAspects: presentAspectsFor(r),
    });

    if (multiEntity) {
      children.push(center(`ENTITAS: ${r.entity.name.toUpperCase()}`, { bold: true, size: 30, after: 360 }));
      children.push(
        labelled("Kedudukan dalam transaksi:", r.entity.role),
      );
    }

    let chNo = 0;
    for (const chapter of plan) {
      if (chapter.kind === "lampiran" || chapter.kind === "disclaimer") continue; // rendered once, globally, below
      chNo++;

      children.push(h1(`BAB ${chapter.numeral} — ${chapter.title}`));

      if (chapter.kind === "pendahuluan") {
        const docCategories = docCategoriesFor(r);
        const contents = chapterPendahuluan({
          transaction, entity: r.entity, regime, meta,
          presentAspects: presentAspectsFor(r), docCategories,
        });
        contents.forEach((content, i) => {
          children.push(h2(`${subNumber(chNo, i)} ${content.title}`));
          for (const el of renderBlocks(content.blocks)) children.push(el);
        });
      } else if (chapter.kind === "profil") {
        if (r.narrative) {
          const blocks = fixStatusRow(renderNarrativeSectionI(r.narrative, r.entity.name), r.entity, regime);
          let subIdx = 0;
          for (const b of blocks) {
            if (b.kind === "heading" && subIdx < chapter.subs.length) {
              children.push(h2(`${subNumber(chNo, subIdx)} ${b.text}`));
              subIdx++;
            } else {
              for (const el of renderBlocks([b])) children.push(el);
            }
          }
        } else {
          children.push(
            p(
              "Profil Perseroan tidak dapat disusun karena dokumen korporasi Perseroan belum diperiksa dalam uji " +
                "tuntas ini."
            )
          );
        }
      } else if (chapter.kind === "analisis_aspek") {
        renderAnalisisAspekChapter(chNo, chapter, r, children);
      } else if (chapter.kind === "transaksi") {
        renderTransaksiChapter(chNo, chapter.subs, transaction.type, children);
      } else if (chapter.kind === "pasar_modal") {
        renderPasarModalChapter(chNo, chapter.subs, regime, r.entity, transaction.type, children);
      } else if (chapter.kind === "bumn") {
        children.push(h2(`${subNumber(chNo, 0)} ${chapter.subs[0].title}`));
        children.push(
          p(
            `${r.entity.name} berada dalam lingkup grup Badan Usaha Milik Negara. Butir-butir di bawah ini ` +
              `disajikan sebagai pertanyaan yang wajib dijawab oleh konsultan hukum penanggung jawab. Peraturan ` +
              `Badan Usaha Milik Negara yang relevan belum diverifikasi kekiniannya untuk keperluan Laporan ini, ` +
              `sehingga Laporan ini tidak menyimpulkannya.`
          )
        );
        const bumnObligations = obligationsForLayer("bumn", transaction.type);
        children.push(obligationTable(bumnObligations));
        for (const para of obligationNotes(bumnObligations)) children.push(para);
      } else if (chapter.kind === "kesimpulan") {
        renderKesimpulanChapter(chNo, chapter.subs, plan, r, children);
      }
    }
    children.push(pageBreak());
  }

  // ---------------- Cross-entity consolidation ----------------
  if (consolidated && results.length > 1) {
    children.push(h1("TEMUAN LINTAS-ENTITAS"));
    const activeCross = consolidated.crossEntityFindings.filter((x) => x.status !== "dismissed");
    if (activeCross.length === 0) {
      children.push(p("Tidak terdapat temuan lintas-entitas."));
    } else {
      for (const el of renderBlocks(renderFindingsTable(activeCross))) children.push(el);
      children.push(p(renderVerdictLine(activeCross), { bold: true }));
    }
    children.push(h2("Rekapitulasi Kelengkapan per Aspek"));
    children.push(
      simpleTable(
        ["Aspek", "Total", "Ada", "Tidak Ada", "Tidak Lengkap", "Kedaluwarsa", "Tidak Berlaku"],
        consolidated.aspectRollup.map((a) => [
          aspectLabel(a.aspectId),
          String(a.totalExpected),
          String(a.present),
          String(a.missing),
          String(a.incomplete),
          String(a.expired),
          String(a.notApplicable),
        ])
      )
    );
    children.push(pageBreak());
  }

  // ---------------- LAMPIRAN (once, covering every entity) ----------------
  children.push(h1("LAMPIRAN"));
  children.push(h2("Lampiran A — Daftar Dokumen yang Diperiksa"));
  for (const r of results) {
    children.push(h3(r.entity.name));
    const rep = r.extractReport;
    if (rep) {
      children.push(
        p(
          `Jumlah dokumen yang disediakan: ${rep.files.length}. Berhasil diekstrak dan diperiksa: ` +
            `${rep.processed}.` +
            (rep.ocrRequired ? ` Memerlukan pengenalan karakter optis (OCR): ${rep.ocrRequired}.` : "") +
            (rep.skipped ? ` Tidak dapat diproses: ${rep.skipped}.` : "")
        )
      );
    }
    if (r.classified.length === 0) {
      children.push(p("Tidak terdapat dokumen terklasifikasi untuk entitas ini."));
      continue;
    }
    children.push(
      simpleTable(
        ["No.", "Nama dokumen", "Uraian", "Tanggal", "Aspek"],
        r.classified.map((d, i) => [
          String(i + 1),
          d.fileName,
          d.docLabel,
          d.docDate ?? "—",
          aspectLabel(d.aspectId),
        ])
      )
    );
  }
  children.push(h2("Lampiran B — Status Kelengkapan Dokumen"));
  for (const r of results) {
    children.push(h3(r.entity.name));
    children.push(
      simpleTable(
        ["Aspek", "Dokumen yang diharapkan", "Status", "Keterangan"],
        r.gaps.map((g) => [
          aspectLabel(g.aspectId),
          g.expectedLabel,
          GAP_LABEL[g.status],
          g.matchedFiles.length ? g.matchedFiles.join(", ") : g.note,
        ])
      )
    );
  }
  children.push(pageBreak());

  // ---------------- DISCLAIMER + signature block ----------------
  children.push(h1("DISCLAIMER"));
  if (primary) {
    for (const el of renderBlocks(chapterDisclaimer({ transaction, entity: primary, meta }))) {
      children.push(el);
    }
  }
  children.push(
    p(
      "Demikian Laporan Uji Tuntas Dari Segi Hukum ini kami sampaikan sesuai dengan ruang lingkup, asumsi, dan " +
        "pembatasan yang diuraikan di dalamnya."
    ),
    p(""),
    p("Hormat kami,"),
    p(""),
    p("SANDIVA LEGAL NETWORK", { bold: true }),
    p(""),
    p(""),
    p(meta.signatoryName, { bold: true }),
    p(meta.signatoryTitle)
  );

  const doc = new Document({
    styles: {
      default: { document: { run: { font: FONT, size: BODY_SIZE } } },
      paragraphStyles: [
        {
          id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 32, bold: true, font: FONT },
          paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
        },
        {
          id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 26, bold: true, font: FONT },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 },
        },
        {
          id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 24, bold: true, font: FONT },
          paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0, format: LevelFormat.BULLET, text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
        {
          reference: "numlist",
          levels: [
            {
              level: 0, format: LevelFormat.DECIMAL, text: "%1.",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [t(`${confidentialityLegend()} — ${meta.matterRef}`, { size: 16 })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18 })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
