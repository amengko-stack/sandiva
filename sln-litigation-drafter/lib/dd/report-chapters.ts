import { transactionLabel } from "@/config/ddTransactionTypes";
import {
  formatIndonesianDate, openingAssumptions, openingQualifications,
} from "@/lib/dd/report-boilerplate";
import type {
  DDAspectId, DDEntity, DDRegime, DDReportBlock, DDReportMeta, DDTransaction,
} from "@/types/dd";

/**
 * BAB I (Pendahuluan) and the closing DISCLAIMER, in the firm's house format:
 * numbered chapters with decimal sub-sections, a scope list carrying EXPLICIT
 * exclusions, and a disclaimer naming the cut-off and the [PERLU VERIFIKASI] /
 * [DOKUMEN TIDAK TERSEDIA] markers.
 *
 * The assumptions and qualifications the professional standard requires are not
 * dropped in favour of the house format — they are carried under 1.6, so the
 * house structure and the standard are satisfied together.
 */

export interface DDChapterContent {
  /** Sub-section title without its decimal number; the builder prefixes that. */
  title: string;
  blocks: DDReportBlock[];
}

const PLACEHOLDER: DDReportMeta = {
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

const meta = (m?: DDReportMeta): DDReportMeta => m ?? PLACEHOLDER;

const ASPECT_SCOPE_LINES: Record<DDAspectId, string> = {
  pendirian_ad:
    "Aspek korporasi: keabsahan pendirian, riwayat perubahan anggaran dasar, dan kesesuaian data korporasi terhadap basis data Kementerian.",
  permodalan_saham:
    "Aspek permodalan: riwayat permodalan, keabsahan penyetoran modal, mata rantai kepemilikan saham, dan susunan pemegang saham.",
  pengurus:
    "Aspek organ Perseroan: susunan dan kewenangan Direksi dan Dewan Komisaris, serta keabsahan keputusan RUPS.",
  perizinan:
    "Aspek perizinan: Nomor Induk Berusaha, perizinan berusaha berbasis risiko, perizinan sektoral, serta perizinan lingkungan dan bangunan.",
  harta_kekayaan:
    "Aspek harta kekayaan: kepemilikan harta bergerak dan tidak bergerak, serta pembebanan dan jaminan yang melekat.",
  perjanjian_penting:
    "Aspek perjanjian material: perjanjian dengan pihak ketiga dan pihak terafiliasi, termasuk ketentuan yang terpicu oleh transaksi.",
  ketenagakerjaan:
    "Aspek ketenagakerjaan: peraturan perusahaan atau perjanjian kerja bersama, struktur tenaga kerja, jaminan sosial, dan perselisihan.",
  perpajakan:
    "Aspek perpajakan dan laporan keuangan: kepatuhan pelaporan serta ketersediaan laporan keuangan auditan.",
  asuransi:
    "Aspek asuransi: polis yang berlaku atas harta kekayaan material dan kecukupan nilai pertanggungan.",
  perkara:
    "Aspek perkara dan sengketa: perkara perdata, pidana, perpajakan, hubungan industrial, dan arbitrase.",
};

/** BAB I sub-sections 1.1–1.6, in order. */
export function chapterPendahuluan(params: {
  transaction: DDTransaction;
  entity: DDEntity;
  regime: DDRegime;
  meta?: DDReportMeta;
  presentAspects: DDAspectId[];
  docCategories: { category: string; period: string; status: string }[];
}): DDChapterContent[] {
  const m = meta(params.meta);
  const { transaction, entity, regime } = params;
  const cutoff = formatIndonesianDate(transaction.cutoffDateISO);
  const start = m.ddStartDateISO ? formatIndonesianDate(m.ddStartDateISO) : "[TANGGAL MULAI]";
  const deal = transactionLabel(transaction.type).toLowerCase();

  const scope: string[] = [];
  for (const a of params.presentAspects) {
    const line = ASPECT_SCOPE_LINES[a];
    if (line) scope.push(line);
  }
  const capitalMarketsScope = regime.parentTbkName
    ? `, serta pengujian kewajiban pasar modal pada tingkat induk berstatus Terbuka (${regime.parentTbkName})`
    : regime.capitalMarkets
      ? ", serta pemenuhan ketentuan pasar modal yang berlaku bagi Perusahaan Terbuka"
      : "";
  scope.push(
    `Aspek kepatuhan transaksi: pemenuhan ketentuan Undang-Undang Perseroan Terbatas yang berlaku bagi ${deal}${capitalMarketsScope}.`
  );

  const statusLine =
    entity.listingStatus === "tbk"
      ? "Perusahaan Terbuka (Tbk)"
      : "Perseroan Terbatas Tertutup (non-Tbk)";
  const parentLine = regime.parentTbkName
    ? `, dengan induk utama ${regime.parentTbkName} yang berstatus Perusahaan Terbuka`
    : "";

  const docTable: DDReportBlock =
    params.docCategories.length > 0
      ? {
          kind: "table",
          headers: ["No.", "Kategori Dokumen", "Periode", "Status"],
          rows: params.docCategories.map((c, i) => [String(i + 1), c.category, c.period, c.status]),
        }
      : { kind: "para", text: "Tidak terdapat dokumen yang dapat dikategorikan." };

  const taxExclusion = m.taxInScope
    ? "."
    : "; serta aspek perpajakan, yang berada di luar lingkup penugasan ini.";

  return [
    {
      title: "Latar Belakang",
      blocks: [
        {
          kind: "para",
          text:
            `Laporan Uji Tuntas Dari Segi Hukum (Legal Due Diligence — selanjutnya disebut "Laporan") ini disusun ` +
            `atas permintaan ${m.clientName} dalam rangka rencana ${deal} atas ${entity.name} ("Perseroan"). ` +
            `Laporan ini dimaksudkan sebagai dasar pertimbangan bagi ${m.addressee} dalam mengambil keputusan atas ` +
            `rencana transaksi tersebut.`,
        },
        {
          kind: "para",
          text:
            `Perseroan berstatus ${statusLine}${parentLine}. Status tersebut menentukan rezim hukum yang berlaku ` +
            `dan diuraikan lebih lanjut dalam Laporan ini.`,
        },
      ],
    },
    {
      title: "Tujuan Uji Tuntas",
      blocks: [
        {
          kind: "para",
          text:
            `Uji tuntas ini bertujuan untuk (i) memeriksa keabsahan pendirian dan riwayat korporasi Perseroan; ` +
            `(ii) mengidentifikasi ketidaksesuaian terhadap ketentuan hukum yang berlaku beserta konsekuensinya; ` +
            `(iii) mengidentifikasi ketentuan perjanjian dan perizinan yang terpicu oleh rencana transaksi; dan ` +
            `(iv) mengidentifikasi dokumen yang belum tersedia sehingga memerlukan tindak lanjut sebelum transaksi ` +
            `dilaksanakan.`,
        },
      ],
    },
    {
      title: "Ruang Lingkup Pemeriksaan",
      blocks: [
        { kind: "para", text: `Pemeriksaan mencakup aspek-aspek hukum berikut, dengan Tanggal Akhir Uji Tuntas ${cutoff}:` },
        { kind: "list", items: scope },
        {
          kind: "para",
          text:
            `Aspek yang TIDAK dicakup: kebenaran data keuangan, teknis, atau komersial Perseroan; kewajaran ` +
            `(fairness) komersial transaksi; valuasi ekonomis harta kekayaan; pendapat ahli teknis; dan analisis ` +
            `hukum yurisdiksi asing selain sebatas identifikasi dan penandaan risiko${taxExclusion}`,
        },
      ],
    },
    {
      title: "Dokumen yang Diperiksa",
      blocks: [
        {
          kind: "para",
          text:
            `Daftar lengkap dokumen yang diperiksa ("Dokumen Yang Diperiksa") disajikan pada Lampiran A. ` +
            `Ringkasan kategori utama adalah sebagai berikut:`,
        },
        docTable,
        {
          kind: "para",
          text:
            `Pemeriksaan dilakukan atas dokumen sebagaimana disediakan kepada kami sampai dengan Tanggal Akhir Uji ` +
            `Tuntas, yaitu ${cutoff}. Peristiwa atau dokumen setelah tanggal tersebut tidak diperiksa.`,
        },
      ],
    },
    {
      title: "Metodologi",
      blocks: [
        {
          kind: "para",
          text:
            `Pemeriksaan dilaksanakan sejak ${start} sampai dengan ${cutoff} atas Dokumen Yang Diperiksa, dengan ` +
            `penelaahan bertingkat dan pemeriksaan silang antar dokumen. Setiap temuan berlabuh pada kutipan ` +
            `dokumen sumber. Penyusunan Laporan ini dibantu oleh sistem kecerdasan artifisial dan wajib ditelaah ` +
            `serta disetujui oleh advokat penanggung jawab sebelum diandalkan.`,
        },
        {
          kind: "para",
          text:
            `Hal yang tidak dapat dipastikan dari Dokumen Yang Diperiksa ditandai "[PERLU VERIFIKASI]" beserta ` +
            `alasannya, dan dokumen yang tidak tersedia ditandai "[DOKUMEN TIDAK TERSEDIA]". Penandaan tersebut ` +
            `menunjukkan hal yang memerlukan tindak lanjut, bukan kesimpulan.`,
        },
      ],
    },
    {
      title: "Asumsi dan Pembatasan",
      blocks: [
        { kind: "para", text: "Laporan ini disusun berdasarkan asumsi-asumsi berikut:" },
        { kind: "list", items: openingAssumptions(m.assumptionsVariant).body },
        { kind: "para", text: "Laporan ini tunduk pada pembatasan berikut:" },
        { kind: "list", items: openingQualifications().body },
      ],
    },
  ];
}

/** The closing DISCLAIMER; the builder appends the signature block after it. */
export function chapterDisclaimer(params: {
  transaction: DDTransaction;
  entity: DDEntity;
  meta?: DDReportMeta;
}): DDReportBlock[] {
  const m = meta(params.meta);
  const cutoff = formatIndonesianDate(params.transaction.cutoffDateISO);
  const deal = transactionLabel(params.transaction.type).toLowerCase();
  return [
    {
      kind: "para",
      text:
        `Laporan Uji Tuntas Dari Segi Hukum ini disusun oleh Sandiva Legal Network untuk ${m.clientName} ` +
        `sehubungan dengan rencana ${deal} atas ${params.entity.name}. Tanggal Akhir Uji Tuntas: ${cutoff}.`,
    },
    {
      kind: "para",
      text:
        `Laporan ini bukan pendapat hukum final. Hal-hal yang ditandai "[PERLU VERIFIKASI]" atau ` +
        `"[DOKUMEN TIDAK TERSEDIA]" memerlukan tindak lanjut sebelum diandalkan.`,
    },
    {
      kind: "para",
      text:
        `Sandiva Legal Network tidak memberikan pendapat atas aspek pajak teknis, valuasi ekonomis, aspek teknis, ` +
        `maupun hukum yurisdiksi asing, selain sebatas identifikasi dan penandaan risiko.`,
    },
    {
      kind: "para",
      text:
        `Laporan ini hanya dapat diandalkan oleh ${m.relianceScope}. Penggunaan Laporan ini oleh pihak lain ` +
        `memerlukan persetujuan tertulis terlebih dahulu dari Sandiva Legal Network.`,
    },
  ];
}
