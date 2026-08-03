import {
  AlignmentType, Document, Footer, Header, HeadingLevel, LevelFormat, PageBreak,
  PageNumber, Packer, Paragraph, Table, TableCell, TableOfContents, TableRow,
  TextRun, WidthType,
} from "docx";
import { aspectLabel } from "@/config/ddAspects";
import { transactionLabel } from "@/config/ddTransactionTypes";
import {
  DD_REPORT_SECTIONS, DD_VII_A_FRAMING, regimeSubsectionsForVII, sectionForAspect,
} from "@/config/ddReportSections";
import {
  confidentialityLegend, deriveVerdict, draftLegend, formatIndonesianDate,
  openingBlocks, verdictLabel,
} from "@/lib/dd/report-boilerplate";
import { obligationsForLayer, resolveRegime } from "@/lib/dd/regime";
import type {
  DDConsolidated, DDEntity, DDEntityResult, DDFinding, DDGapItem, DDRegime,
  DDReportMeta, DDTransaction,
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

// Verbatim quotations are indented and italicised — the precedents rely on the
// quote being visually separable from counsel's own analysis.
const quote = (text: string) =>
  new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 120 },
    indent: { left: 720, right: 720 },
    children: [t(text, { italics: true })],
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

const GAP_LABEL: Record<DDGapItem["status"], string> = {
  present: "Ada", incomplete: "Tidak lengkap", expired: "Kedaluwarsa",
  missing: "TIDAK ADA", not_applicable: "Tidak berlaku",
};
const GAP_FILL: Record<DDGapItem["status"], string> = {
  present: "D1FAE5", incomplete: "FEF3C7", expired: "FED7AA",
  missing: "FEE2E2", not_applicable: "E5E7EB",
};
const SEV_ORDER: DDFinding["severity"][] = ["kritis", "material", "minor"];
const SEV_COLOR: Record<DDFinding["severity"], string> = {
  kritis: "B91C1C", material: "B45309", minor: "374151",
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

/**
 * A finding rendered in the house style the precedents and the published IDX
 * LUT converge on: fact, then the verbatim quotation, then the analysis, then
 * the recommendation. The verbatim quote sits between fact and analysis so a
 * reader can check counsel's reading against the source text.
 */
function findingParas(f: DDFinding): Paragraph[] {
  const out: Paragraph[] = [
    new Paragraph({
      spacing: { before: 160, after: 80 },
      children: [
        t(`[${f.severity.toUpperCase()}] `, { bold: true, color: SEV_COLOR[f.severity] }),
        t(f.editedProblem ?? f.problem, { bold: true }),
        ...(f.verified ? [t("  ✓ terverifikasi", { color: "059669" })] : []),
      ],
    }),
  ];
  if (f.sourceFile) {
    out.push(labelled("Sumber:", f.sourceFile));
  }
  if (f.anchor) {
    out.push(p("Kutipan:"), quote(`"${f.anchor}"`));
  }
  out.push(labelled("Analisis:", f.whyItMatters));
  out.push(labelled("Rekomendasi:", f.suggestedFix));
  if (f.regulationRefs && f.regulationRefs.length > 0) {
    out.push(labelled("Dasar hukum:", f.regulationRefs.join("; ")));
  }
  if (f.currencyStatus === "superseded" && f.currencyNote) {
    out.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          t(`Catatan kekinian peraturan: ${f.currencyNote}`, { bold: true, color: "C2410C" }),
        ],
      })
    );
  }
  return out;
}

/** Obligation table for one VII sub-section. */
function obligationTable(layer: Parameters<typeof obligationsForLayer>[0], txnType: DDTransaction["type"]): Table {
  const obligations = obligationsForLayer(layer, txnType);
  return simpleTable(
    ["Kewajiban", "Dasar hukum", "Jangka waktu / ambang"],
    obligations.map((ob) => [ob.label, ob.basis, ob.timing])
  );
}

function obligationNotes(
  layer: Parameters<typeof obligationsForLayer>[0],
  txnType: DDTransaction["type"]
): Paragraph[] {
  const withNotes = obligationsForLayer(layer, txnType).filter((ob) => ob.note);
  if (withNotes.length === 0) {
    return [];
  }
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

/** VII.B — the capital-markets sub-section, whose content depends on which layer applies. */
function capitalMarketsSection(
  regime: DDRegime,
  entity: DDEntity,
  txnType: DDTransaction["type"]
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const viaParent = regime.parentTbkName !== null;
  const layer = viaParent ? "pasar_modal_induk" : "pasar_modal_langsung";

  if (viaParent) {
    out.push(
      p(
        `${entity.name} bukan merupakan Perusahaan Terbuka dan karena itu tidak terikat secara langsung oleh ` +
          `peraturan Otoritas Jasa Keuangan. Namun demikian, induk utamanya, ${regime.parentTbkName}, berstatus ` +
          `Perusahaan Terbuka. POJK 17/POJK.04/2020 mencakup setiap transaksi yang dilakukan oleh Perusahaan ` +
          `Terbuka atau perusahaan terkendali, dengan ambang materialitas diukur terhadap angka induk. Karena itu ` +
          `transaksi atas saham atau aset ${entity.name} dapat merupakan Transaksi Material bagi ` +
          `${regime.parentTbkName}, dan kewajiban yang timbul melekat pada induk tersebut — bukan pada ` +
          `${entity.name}.`
      ),
      p(
        `Angka keuangan induk berada di luar lingkup uji tuntas dari segi hukum. Hasil pengujian rasio di bawah ` +
          `ini hanya dapat dipastikan setelah data keuangan induk disediakan dan diverifikasi oleh pihak yang ` +
          `berkompeten; sepanjang data tersebut tidak tersedia, hasilnya ditandai ` +
          `"[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]".`
      ),
      h3("Pengujian Ambang Transaksi Material terhadap Induk"),
      simpleTable(
        ["Rasio yang diuji", "Ambang", "Hasil"],
        [
          [
            "Nilai transaksi terhadap ekuitas induk",
            "20% (10% dari total aset bila ekuitas induk negatif)",
            "[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]",
          ],
          [
            "Total aset objek transaksi terhadap total aset induk",
            "20%",
            "[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]",
          ],
          [
            "Laba bersih objek transaksi terhadap laba bersih induk",
            "20%",
            "[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]",
          ],
          [
            "Pendapatan objek transaksi terhadap pendapatan induk",
            "20%",
            "[PERLU VERIFIKASI — data keuangan induk di luar lingkup uji tuntas hukum]",
          ],
        ]
      ),
      p(
        `Dasar penghitungan adalah laporan keuangan triwulanan terakhir induk yang telah direviu atau diaudit.`
      ),
      h3("Kewajiban yang Timbul pada Tingkat Induk")
    );
  } else {
    out.push(
      p(
        `${entity.name} berstatus Perusahaan Terbuka. Selain Undang-Undang Perseroan Terbatas, ${entity.name} ` +
          `tunduk pada Undang-Undang Pasar Modal beserta peraturan pelaksanaannya, peraturan Otoritas Jasa ` +
          `Keuangan, dan peraturan Bursa Efek. Bagian ini menguji kepatuhan terhadap ketentuan Transaksi ` +
          `Material, Transaksi Afiliasi dan Benturan Kepentingan, serta — sepanjang transaksi mengakibatkan ` +
          `perubahan Pengendali — ketentuan Pengambilalihan Perusahaan Terbuka.`
      ),
      h3("Kewajiban Berdasarkan Ketentuan Pasar Modal")
    );
  }

  out.push(obligationTable(layer, txnType));
  for (const para of obligationNotes(layer, txnType)) {
    out.push(para);
  }
  return out;
}

/** VIII — tri-state conclusions, per report section then overall. */
function conclusionSection(r: DDEntityResult): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const active = r.findings.filter((f) => f.status !== "dismissed");

  out.push(
    p(
      `Kesimpulan di bawah ini disusun untuk setiap bagian Laporan ini dengan tiga kemungkinan penilaian: ` +
        `memenuhi ketentuan; memenuhi ketentuan dengan catatan, dalam hal mana catatan tersebut menguraikan ` +
        `risiko hukumnya; atau tidak memenuhi ketentuan.`
    )
  );

  const rows: string[][] = [];
  for (const section of DD_REPORT_SECTIONS) {
    if (section.aspectIds.length === 0) {
      continue;
    }
    const sectionFindings = active.filter(
      (f) => f.aspectId !== null && sectionForAspect(f.aspectId).id === section.id
    );
    const verdict = deriveVerdict(sectionFindings);
    const counts = SEV_ORDER.map(
      (sev) => `${sectionFindings.filter((f) => f.severity === sev).length} ${sev}`
    ).join(", ");
    rows.push([
      `${section.numeral}. ${section.title}`,
      verdictLabel(verdict),
      sectionFindings.length === 0 ? "tidak ada temuan" : counts,
    ]);
  }
  out.push(simpleTable(["Bagian", "Penilaian", "Temuan"], rows));

  const overall = deriveVerdict(active);
  out.push(
    new Paragraph({
      spacing: { before: 240, after: 120 },
      children: [
        t("Kesimpulan keseluruhan: ", { bold: true }),
        t(
          `berdasarkan Dokumen Yang Diperiksa dan dengan memperhatikan seluruh asumsi dan pembatasan dalam ` +
            `Laporan ini, ${r.entity.name} `,
        ),
        t(verdictLabel(overall), { bold: true }),
        t("."),
      ],
    })
  );

  if (overall !== "memenuhi") {
    out.push(
      p(
        `Uraian atas setiap catatan dan ketidaksesuaian, beserta dasar hukum dan sanksinya, disajikan pada ` +
          `bagian-bagian terkait di atas.`
      )
    );
  }
  return out;
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
  // clause in part E would otherwise name nobody while the cover asserts the
  // report is releasable.
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
          "dokumen yang masih belum lengkap dan pada verifikasi yang belum dilakukan. Lihat bagian Asumsi dan " +
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
  // Word renders the field on first open; the reader may need Ctrl+A, F9.
  children.push(
    h1("DAFTAR ISI"),
    new TableOfContents("Daftar Isi", { hyperlink: true, headingStyleRange: "1-3" }),
    pageBreak()
  );

  // ---------------- Daftar Definisi ----------------
  const defRows: string[][] = [
    ["“Laporan”", "Laporan Uji Tuntas Dari Segi Hukum ini, termasuk seluruh lampirannya."],
    [
      "“Tanggal Akhir Uji Tuntas”",
      `${cutoffLong} — tanggal batas akhir pemeriksaan; peristiwa setelah tanggal tersebut tidak diperiksa.`,
    ],
    [
      "“Dokumen Yang Diperiksa”",
      "Dokumen yang disediakan kepada kami dan diperiksa sebagaimana tercantum dalam Lampiran A.",
    ],
    ["“UUPT”", "Undang-Undang No. 40 Tahun 2007 tentang Perseroan Terbatas, sebagaimana telah diubah."],
    ["“RUPS”", "Rapat Umum Pemegang Saham."],
    ["“OJK”", "Otoritas Jasa Keuangan."],
  ];
  for (const r of results) {
    defRows.push([`“${r.entity.name}”`, `Perseroan yang diperiksa dalam kapasitas sebagai ${r.entity.role}.`]);
  }
  children.push(h1("DAFTAR DEFINISI DAN SINGKATAN"), simpleTable(["Istilah", "Definisi"], defRows), pageBreak());

  // ---------------- Opening matter A–E ----------------
  children.push(h1("PEMBUKAAN"));
  if (primary) {
    const blocks = openingBlocks({
      transaction,
      entity: primary,
      regime: resolveRegime(primary),
      meta,
    });
    for (const block of blocks) {
      children.push(h2(`${block.letter}. ${block.heading}`));
      for (const body of block.body) {
        // Enumerated items arrive marked "(i) …" / "(a) …" — indent them.
        const enumerated = /^\((?:[ivx]+|[a-k])\)\s/.test(body);
        children.push(p(body, enumerated ? { indent: 720 } : {}));
      }
    }
  }
  children.push(pageBreak());

  // ---------------- Per entity: sections I–VIII ----------------
  for (const r of results) {
    const regime = resolveRegime(r.entity);
    const active = r.findings.filter((f) => f.status !== "dismissed");

    children.push(h1(r.entity.name.toUpperCase()));
    children.push(
      labelled("Kedudukan dalam transaksi:", r.entity.role),
      labelled(
        "Status perusahaan:",
        r.entity.listingStatus === "tbk"
          ? "Perusahaan Terbuka (Tbk)"
          : "Perseroan Terbatas Tertutup (non-Tbk)"
      )
    );
    if (regime.parentTbkName) {
      children.push(labelled("Induk utama berstatus Terbuka:", regime.parentTbkName));
    }
    children.push(p(""));

    for (const section of DD_REPORT_SECTIONS) {
      // VII and VIII are built from the regime and the verdicts, not from aspects.
      if (section.id === "VII") {
        children.push(h2(`${section.numeral}. ${section.title}`));
        const subs = regimeSubsectionsForVII(regime);
        for (const sub of subs) {
          if (sub.layer === "uupt") {
            const framing = DD_VII_A_FRAMING[transaction.type];
            children.push(h3(`${sub.id}. ${framing.heading}`));
            children.push(p(framing.framing));
            children.push(obligationTable("uupt", transaction.type));
            for (const para of obligationNotes("uupt", transaction.type)) {
              children.push(para);
            }
          } else if (sub.layer === "pasar_modal_langsung") {
            children.push(h3(`${sub.id}. ${sub.title}`));
            for (const el of capitalMarketsSection(regime, r.entity, transaction.type)) {
              children.push(el);
            }
          } else {
            children.push(h3(`${sub.id}. ${sub.title}`));
            children.push(
              p(
                `${r.entity.name} berada dalam lingkup grup Badan Usaha Milik Negara. Butir-butir di bawah ini ` +
                  `disajikan sebagai pertanyaan yang wajib dijawab oleh konsultan hukum penanggung jawab. ` +
                  `Peraturan Badan Usaha Milik Negara yang relevan belum diverifikasi kekiniannya untuk ` +
                  `keperluan Laporan ini, sehingga Laporan ini tidak menyimpulkannya.`
              )
            );
            children.push(obligationTable("bumn", transaction.type));
            for (const para of obligationNotes("bumn", transaction.type)) {
              children.push(para);
            }
          }
        }
        continue;
      }

      if (section.id === "VIII") {
        children.push(h2(`${section.numeral}. ${section.title}`));
        for (const el of conclusionSection(r)) {
          children.push(el);
        }
        continue;
      }

      // Sections I–VI: gaps and findings belonging to this section's aspects.
      children.push(h2(`${section.numeral}. ${section.title}`));

      const sectionGaps = r.gaps.filter(
        (g) => sectionForAspect(g.aspectId).id === section.id
      );
      const sectionFindings = active.filter(
        (f) => f.aspectId !== null && sectionForAspect(f.aspectId).id === section.id
      );

      if (sectionGaps.length === 0 && sectionFindings.length === 0) {
        children.push(
          p(
            "Tidak terdapat dokumen yang diperiksa maupun temuan yang dapat dilaporkan untuk bagian ini " +
              "berdasarkan Dokumen Yang Diperiksa."
          )
        );
        continue;
      }

      if (sectionGaps.length > 0) {
        children.push(h3("Kelengkapan Dokumen"));
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [
                  cell("Aspek", { bold: true }),
                  cell("Dokumen yang diharapkan", { bold: true }),
                  cell("Status", { bold: true }),
                  cell("Keterangan", { bold: true }),
                ],
              }),
              ...sectionGaps.map(
                (g) =>
                  new TableRow({
                    children: [
                      cell(aspectLabel(g.aspectId)),
                      cell(g.expectedLabel),
                      cell(GAP_LABEL[g.status], { fill: GAP_FILL[g.status] }),
                      cell(g.matchedFiles.length ? g.matchedFiles.join(", ") : g.note),
                    ],
                  })
              ),
            ],
          })
        );
      }

      // Section IV carries the key-terms tables for material agreements.
      if (section.id === "IV" && r.rows.length > 0) {
        children.push(h3("Ketentuan Kunci Perjanjian"));
        for (const row of r.rows) {
          children.push(p(row.agreementLabel, { bold: true }));
          if (row.memberFiles.length > 1) {
            children.push(
              p(`(${row.memberFiles.length} dokumen: perjanjian induk beserta addendum)`, { italics: true })
            );
          }
          children.push(
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: [
                new TableRow({
                  children: [
                    cell("Ketentuan", { bold: true }),
                    cell("Isi", { bold: true }),
                    cell("Kutipan", { bold: true }),
                  ],
                }),
                ...row.cells.map(
                  (c) =>
                    new TableRow({
                      children: [
                        cell(c.fieldId.replace(/_/g, " ")),
                        cell(
                          `${c.dealTriggered ? "⚠ " : ""}${c.value}`,
                          c.dealTriggered ? { fill: "FEE2E2" } : {}
                        ),
                        cell(c.verbatim || "—"),
                      ],
                    })
                ),
              ],
            })
          );
          children.push(p(""));
        }
      }

      if (sectionFindings.length > 0) {
        children.push(h3("Temuan"));
        for (const sev of SEV_ORDER) {
          for (const f of sectionFindings.filter((x) => x.severity === sev)) {
            for (const para of findingParas(f)) {
              children.push(para);
            }
          }
        }
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
      for (const f of activeCross) {
        for (const para of findingParas(f)) {
          children.push(para);
        }
      }
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

  // ---------------- Lampiran A: documents examined ----------------
  children.push(h1("LAMPIRAN A — DAFTAR DOKUMEN YANG DIPERIKSA"));
  for (const r of results) {
    children.push(h2(r.entity.name));
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

  // ---------------- Signature block ----------------
  children.push(
    pageBreak(),
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
