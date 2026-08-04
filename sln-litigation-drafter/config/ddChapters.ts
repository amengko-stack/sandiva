import type { DDAspectId, DDRegime, DDReportFormat, DDTransactionType } from "@/types/dd";
import { hasLayer } from "@/lib/dd/regime";

/**
 * Chapter plan for the report, in the firm's house format: BAB I..N with decimal
 * sub-numbering (1.1, 7.1.1), a descriptive profile chapter, one analysis chapter
 * per relevant aspect, a transaction-specific block, conclusions, annexes and a
 * disclaimer.
 *
 * Chapters are computed per transaction type rather than fixed, because the
 * reference report is a dissolution: copying its BAB VIII-XII verbatim would put
 * liquidator and asset-liquidation chapters into a share acquisition, and would
 * leave no home for the audited financial statements and insurance that HKHSK
 * Annex VII requires as mandatory examination areas 7 and 8.
 *
 * Deliberately NO risk-level column or rating anywhere: checked against all three
 * Makarim precedents and the professional-standard notes, Indonesian LDD
 * convention does not use one (the Tinggi/Sedang/Rendah scale in the reference
 * report is that report's own house device). The standard mandates a three-state
 * conclusion instead — memenuhi / memenuhi dengan catatan / tidak memenuhi.
 */
export type DDChapterKind =
  | "pendahuluan"
  | "profil"
  | "analisis_aspek"
  | "transaksi"
  | "pasar_modal"
  | "bumn"
  | "kesimpulan"
  | "lampiran"
  | "disclaimer"
  // Added for exec_summary_led / findings_only / lut_pasar_modal (see planChapters).
  | "ringkasan"      // RINGKASAN EKSEKUTIF, numbered like any other chapter
  | "kategori"       // exec_summary_led: description + analysis fused per document category
  | "transaksi_jual" // sell-side transaction block, replaces "transaksi" when clientRole is the seller
  | "temuan"         // findings_only: one bare findings chapter per aspect
  | "rekomendasi";   // findings_only: REKOMENDASI DAN TINDAK LANJUT

export interface DDChapterSub {
  /** Decimal number, filled in once the chapter number is known. */
  title: string;
  /** For analysis chapters, the aspects whose material belongs here. */
  aspectIds?: DDAspectId[];
  /** True for the "Temuan" sub-section that closes an analysis chapter. */
  findings?: boolean;
}

export interface DDChapterPlan {
  kind: DDChapterKind;
  /** Roman numeral, assigned by planChapters. */
  numeral: string;
  title: string;
  aspectIds: DDAspectId[];
  subs: DDChapterSub[];
}

const ROMAN = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII",
];

/** BAB I — mirrors the reference report's 1.1–1.6. */
const PENDAHULUAN_SUBS: DDChapterSub[] = [
  { title: "Latar Belakang" },
  { title: "Tujuan Uji Tuntas" },
  { title: "Ruang Lingkup Pemeriksaan" },
  { title: "Dokumen yang Diperiksa" },
  { title: "Metodologi" },
  { title: "Asumsi dan Pembatasan" },
];

/** BAB II — the descriptive chapter; tables, not exceptions. */
const PROFIL_SUBS: DDChapterSub[] = [
  { title: "Data Korporasi" },
  { title: "Riwayat Pendirian dan Perubahan Anggaran Dasar" },
  { title: "Maksud, Tujuan dan Kegiatan Usaha" },
  { title: "Struktur Permodalan dan Pemegang Saham" },
  { title: "Susunan Direksi" },
  { title: "Susunan Dewan Komisaris" },
];

/** One analysis chapter per aspect cluster. Each closes with its own Temuan. */
interface AspectChapterDef {
  title: string;
  /** Title-case name for the closing findings sub-section; the chapter title is
   *  upper-case for the BAB heading, which reads wrong inside a sub-section. */
  findingsTitle: string;
  aspectIds: DDAspectId[];
  subs: string[];
}

const ASPECT_CHAPTERS: AspectChapterDef[] = [
  {
    title: "ANALISIS KORPORASI",
    findingsTitle: "Temuan Aspek Korporasi",
    aspectIds: ["pendirian_ad", "permodalan_saham", "pengurus"],
    subs: [
      "Keabsahan Pendirian dan Anggaran Dasar",
      "Riwayat Permodalan dan Keabsahan Kepemilikan Saham",
      "Kepatuhan RUPS dan Kewenangan Organ Perseroan",
      "Kepatuhan Pelaporan Korporasi",
    ],
  },
  {
    title: "ANALISIS PERIZINAN DAN KEPATUHAN",
    findingsTitle: "Temuan Aspek Perizinan",
    aspectIds: ["perizinan"],
    subs: [
      "Nomor Induk Berusaha dan Perizinan Berbasis Risiko",
      "Perizinan Sektoral",
      "Perizinan Lingkungan dan Bangunan",
    ],
  },
  {
    title: "ANALISIS HARTA KEKAYAAN DAN ASURANSI",
    findingsTitle: "Temuan Aspek Harta Kekayaan dan Asuransi",
    aspectIds: ["harta_kekayaan", "asuransi"],
    subs: [
      "Harta Tidak Bergerak",
      "Harta Bergerak",
      "Pembebanan dan Jaminan",
      "Perlindungan Asuransi",
    ],
  },
  {
    title: "ANALISIS PERJANJIAN MATERIAL",
    findingsTitle: "Temuan Aspek Perjanjian Material",
    aspectIds: ["perjanjian_penting"],
    subs: [
      "Perjanjian dengan Pihak Ketiga",
      "Perjanjian dengan Pihak Terafiliasi",
      "Ketentuan yang Terpicu oleh Transaksi",
    ],
  },
  {
    title: "ANALISIS KETENAGAKERJAAN",
    findingsTitle: "Temuan Aspek Ketenagakerjaan",
    aspectIds: ["ketenagakerjaan"],
    subs: [
      "Peraturan Perusahaan atau Perjanjian Kerja Bersama",
      "Struktur Tenaga Kerja dan Perjanjian Kerja",
      "Upah Minimum dan Jaminan Sosial",
      "Tenaga Kerja Asing",
    ],
  },
  {
    title: "ANALISIS PERPAJAKAN",
    findingsTitle: "Temuan Aspek Perpajakan dan Laporan Keuangan",
    aspectIds: ["perpajakan"],
    subs: ["Kepatuhan Pelaporan dan Pembayaran", "Laporan Keuangan Auditan"],
  },
  {
    title: "ANALISIS PERKARA DAN SENGKETA",
    findingsTitle: "Temuan Aspek Perkara dan Sengketa",
    aspectIds: ["perkara"],
    subs: [
      "Perkara Perdata dan Arbitrase",
      "Perkara Ketenagakerjaan",
      "Perkara Pidana dan Perpajakan",
      "Pernyataan Perseroan serta Direksi dan Dewan Komisaris",
    ],
  },
];

/** The transaction-specific block. Dissolution gets the multi-chapter treatment. */
function transactionChapters(type: DDTransactionType): { title: string; subs: string[] }[] {
  switch (type) {
    case "likuidasi":
      return [
        {
          title: "DASAR DAN ALASAN PEMBUBARAN",
          subs: ["Dasar Hukum Pembubaran", "Alasan Pembubaran", "Keabsahan Keputusan RUPS Pembubaran"],
        },
        {
          title: "ANALISIS LIKUIDATOR",
          subs: ["Pengangkatan Likuidator", "Kewajiban dan Wewenang Likuidator", "Urutan Pembayaran dalam Likuidasi"],
        },
        {
          title: "KEWAJIBAN YANG HARUS DISELESAIKAN",
          subs: [
            "Kewajiban kepada Kreditor",
            "Kewajiban Ketenagakerjaan",
            "Kewajiban Perpajakan",
            "Kewajiban dari Perjanjian yang Harus Diakhiri",
            "Kewajiban dari Perkara yang Berjalan",
          ],
        },
        {
          title: "PROSES PEMBUBARAN DAN LIKUIDASI",
          subs: ["Tahapan Pembubaran menurut UUPT", "Pengumuman dan Jangka Waktu"],
        },
      ];
    case "merger":
      return [
        {
          title: "KEPATUHAN PROSEDUR PENGGABUNGAN",
          subs: [
            "Rancangan Penggabungan",
            "Persetujuan RUPS",
            "Pengumuman dan Pemberitahuan kepada Karyawan",
            "Keberatan Kreditor",
            "Hak Pemegang Saham yang Tidak Setuju",
            "Notifikasi Persaingan Usaha",
          ],
        },
      ];
    case "akuisisi_saham":
    case "divestasi":
      return [
        {
          title: "KEPATUHAN PROSEDUR PENGAMBILALIHAN SAHAM",
          subs: [
            "Kewenangan Penjual dan Keabsahan Objek Transaksi",
            "Persetujuan Korporasi yang Disyaratkan",
            "Pengumuman dan Pemberitahuan kepada Karyawan",
            "Keberatan Kreditor",
            "Hak Pemegang Saham yang Tidak Setuju",
            "Persetujuan Pihak Ketiga atas Perubahan Pengendalian",
            "Notifikasi Persaingan Usaha",
          ],
        },
      ];
    case "akuisisi_aset":
      return [
        {
          title: "KEPATUHAN PROSEDUR PENGALIHAN KEKAYAAN",
          subs: [
            "Keabsahan Kepemilikan Objek yang Dialihkan",
            "Persetujuan RUPS atas Pengalihan Kekayaan",
            "Pembebanan yang Melekat pada Objek",
            "Notifikasi Persaingan Usaha",
          ],
        },
      ];
    default:
      // streamlining / joint_venture have no bespoke statutory sequence; the
      // chapter is framed generically rather than invented.
      return [
        {
          title: "KEPATUHAN ASPEK KORPORASI TRANSAKSI",
          subs: ["Langkah Korporasi yang Ditempuh", "Persetujuan Korporasi yang Disyaratkan", "Notifikasi Persaingan Usaha"],
        },
      ];
  }
}

const KESIMPULAN_SUBS: DDChapterSub[] = [
  { title: "Ringkasan Temuan" },
  { title: "Penilaian Kepatuhan per Bab" },
  { title: "Hal yang Memerlukan Konfirmasi Lebih Lanjut" },
  { title: "Rekomendasi Tindak Lanjut" },
];

const LAMPIRAN_SUBS: DDChapterSub[] = [
  { title: "Lampiran A — Daftar Dokumen yang Diperiksa" },
  { title: "Lampiran B — Status Kelengkapan Dokumen" },
];

// ---------------------------------------------------------------------------
// exec_summary_led — organised by document category, description and analysis
// fused in the same chapter (LDD_Report_SBN_Divestment /
// LDD_SBN_Annotated_Mode2_HybridFraming). Bilingual titles are verbatim from
// the sample; the English gloss is kept in a trailing "(...)" so the builder
// can strip it with one regex when bilingualHeadings is off.
// ---------------------------------------------------------------------------
interface CategoryChapterDef {
  title: string;
  findingsTitle: string;
  aspectIds: DDAspectId[];
  subs: string[];
}

const CATEGORY_CHAPTERS: CategoryChapterDef[] = [
  {
    title: "INFORMASI KORPORASI (CORPORATE INFORMATION)",
    findingsTitle: "Temuan — Informasi Korporasi",
    aspectIds: ["pendirian_ad", "permodalan_saham", "pengurus"],
    subs: [
      "Informasi Korporasi Utama",
      "Riwayat Pendirian dan Akta Perubahan",
      "Susunan Pemegang Saham Terkini",
      "Susunan Direksi dan Dewan Komisaris Terkini",
      "Struktur Grup Kepemilikan",
    ],
  },
  {
    title: "IZIN-IZIN USAHA (LICENSES AND PERMITS)",
    findingsTitle: "Temuan — Izin-Izin Usaha",
    aspectIds: ["perizinan"],
    subs: [
      "Izin Dasar dan Identitas Berusaha",
      "Izin Operasional dan Sertifikat Standar",
      "Perizinan BPJS dan Kepatuhan Ketenagakerjaan",
      "Izin yang Belum Diidentifikasi / Perlu Verifikasi",
    ],
  },
  {
    title: "PERJANJIAN PINJAMAN DAN KONTRAK PIHAK KETIGA (LOAN AGREEMENTS & THIRD PARTY CONTRACTS)",
    findingsTitle: "Temuan — Perjanjian Pinjaman dan Kontrak Pihak Ketiga",
    aspectIds: ["perjanjian_penting"],
    subs: [
      "Perjanjian Pinjaman",
      "Kontrak Material dengan Pihak Ketiga",
      "Status Hutang Usaha",
      "Kontrak Material — Inventarisasi Wajib",
    ],
  },
  {
    title: "ASET TANAH DAN PROPERTI (LAND AND PROPERTY)",
    findingsTitle: "Temuan — Aset Tanah dan Properti",
    aspectIds: ["harta_kekayaan", "asuransi"],
    subs: ["Status Kepemilikan Aset Tanah dan Bangunan", "Sewa", "Aset Lainnya"],
  },
  {
    title: "KETENAGAKERJAAN (LABOUR)",
    findingsTitle: "Temuan — Ketenagakerjaan",
    aspectIds: ["ketenagakerjaan"],
    subs: ["Profil Karyawan", "Dokumen Ketenagakerjaan yang Tersedia", "Kepatuhan Ketenagakerjaan"],
  },
  {
    title: "PERKARA HUKUM (LITIGATION)",
    findingsTitle: "Temuan — Perkara Hukum",
    aspectIds: ["perkara"],
    subs: ["Status Perkara Aktif", "Surat Pernyataan dan Tindakan Pra-Penandatanganan"],
  },
  {
    title: "PERPAJAKAN (TAX MATTERS)",
    findingsTitle: "Temuan — Perpajakan",
    aspectIds: ["perpajakan"],
    subs: ["Status Wajib Pajak", "SPT Tahunan dan Kepatuhan Pajak", "Laporan Keuangan Auditan"],
  },
];

/** Formal Indonesian label for a transaction type, used in implication titles. */
function transactionLabel(type: DDTransactionType): string {
  switch (type) {
    case "divestasi":
      return "Divestasi";
    case "akuisisi_saham":
      return "Akuisisi Saham";
    case "akuisisi_aset":
      return "Akuisisi Aset";
    case "merger":
      return "Penggabungan";
    case "likuidasi":
      return "Pembubaran";
    case "joint_venture":
      return "Joint Venture";
    default:
      return "Transaksi";
  }
}

/** Per-chapter "Implikasi terhadap <transaksi>" sub, as the SBN sample uses. */
function implicationSub(categoryTitle: string, type: DDTransactionType): DDChapterSub {
  const label = transactionLabel(type);
  if (categoryTitle.startsWith("KETENAGAKERJAAN")) {
    return { title: `Implikasi ${label} terhadap Pekerja` };
  }
  return { title: `Implikasi terhadap ${label}` };
}

// ---------------------------------------------------------------------------
// Sell-side transaction block. The SBN report is written for the SELLER: it
// does not ask whether the seller may transfer, it proves it, so this REPLACES
// transactionChapters() rather than supplementing it, whenever the firm acts
// for the seller in a divestasi or akuisisi_saham. Applies across formats.
// ---------------------------------------------------------------------------
function isSellerRole(clientRole: string | undefined): boolean {
  if (!clientRole) return false;
  return /penjual|seller/i.test(clientRole);
}

function sellSideChapters(): { title: string; subs: string[] }[] {
  return [
    {
      title: "STRUKTUR TRANSAKSI DIVESTASI",
      subs: ["Ringkasan Transaksi", "Jenis Divestasi", "Alasan Divestasi", "Persetujuan Internal yang Diperlukan"],
    },
    {
      title: "ANALISIS CLEAN TITLE (KEABSAHAN OBJEK JUAL)",
      subs: [
        "Verifikasi Kepemilikan Saham yang Dijual",
        "Hak Memesan Efek Terlebih Dahulu",
        "Shareholders Agreement",
        "Pembatasan Regulasi atas Pengalihan",
      ],
    },
    {
      title: "KESIAPAN DATA ROOM",
      subs: [
        "Checklist Dokumen untuk Data Room",
        "Dokumen yang Belum Tersedia",
        "Dokumen yang Perlu Diredaksi Sebelum Dibagikan",
      ],
    },
    {
      title: "ISU YANG PERLU DIUNGKAPKAN KEPADA PEMBELI",
      subs: ["Disclosure Wajib", "Isu yang Perlu Diselesaikan Sebelum Closing", "Isu yang Dapat Mempengaruhi Harga"],
    },
    {
      title: "KEWAJIBAN PENJUAL PASCA-CLOSING",
      subs: [
        "Kewajiban Transisi",
        "Non-Compete dan Non-Solicitation",
        "Indemnifikasi dalam SPA",
        "Escrow atau Holdback",
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// findings_only — bare exceptions report: one findings chapter per aspect
// present, no profile chapter, no per-aspect analysis subs.
// ---------------------------------------------------------------------------
const ASPECT_LABELS: Record<DDAspectId, string> = {
  pendirian_ad: "Pendirian dan Anggaran Dasar",
  permodalan_saham: "Permodalan dan Saham",
  pengurus: "Pengurus",
  perizinan: "Perizinan",
  harta_kekayaan: "Harta Kekayaan",
  perjanjian_penting: "Perjanjian Penting",
  ketenagakerjaan: "Ketenagakerjaan",
  perpajakan: "Perpajakan",
  asuransi: "Asuransi",
  perkara: "Perkara",
};

const ASPECT_ORDER: DDAspectId[] = [
  "pendirian_ad",
  "permodalan_saham",
  "pengurus",
  "perizinan",
  "harta_kekayaan",
  "perjanjian_penting",
  "ketenagakerjaan",
  "perpajakan",
  "asuransi",
  "perkara",
];

// ---------------------------------------------------------------------------
// lut_pasar_modal — prescribed by HKHSK Annex VII / POJK 7/2017: the eleven
// mandatory examination areas, in order. Not a free choice, so BAB I
// Pendahuluan is kept and the areas are not reorganised by category.
// ---------------------------------------------------------------------------
interface LutAreaDef {
  title: string;
  findingsTitle: string;
  aspectIds: DDAspectId[];
  sub: string;
}

const LUT_AREAS: LutAreaDef[] = [
  { title: "ANALISIS ANGGARAN DASAR", findingsTitle: "Temuan Anggaran Dasar", aspectIds: ["pendirian_ad"], sub: "Keabsahan Pendirian dan Anggaran Dasar" },
  { title: "ANALISIS RISALAH RAPAT DIREKSI, DEWAN KOMISARIS DAN RUPS (3 TAHUN TERAKHIR)", findingsTitle: "Temuan Risalah Rapat", aspectIds: ["pengurus"], sub: "Risalah Rapat Direksi, Dewan Komisaris dan RUPS" },
  { title: "ANALISIS STRUKTUR PERMODALAN DAN PEMEGANG SAHAM", findingsTitle: "Temuan Struktur Permodalan dan Pemegang Saham", aspectIds: ["permodalan_saham"], sub: "Struktur Permodalan dan Susunan Pemegang Saham" },
  { title: "ANALISIS DIREKSI DAN DEWAN KOMISARIS", findingsTitle: "Temuan Direksi dan Dewan Komisaris", aspectIds: ["pengurus"], sub: "Susunan dan Kewenangan Direksi dan Dewan Komisaris" },
  { title: "ANALISIS PERIZINAN", findingsTitle: "Temuan Perizinan", aspectIds: ["perizinan"], sub: "Perizinan Berusaha" },
  { title: "ANALISIS HARTA KEKAYAAN", findingsTitle: "Temuan Harta Kekayaan", aspectIds: ["harta_kekayaan"], sub: "Harta Kekayaan Perseroan" },
  { title: "ANALISIS LAPORAN KEUANGAN AUDITAN (3 TAHUN TERAKHIR)", findingsTitle: "Temuan Laporan Keuangan Auditan", aspectIds: ["perpajakan"], sub: "Laporan Keuangan Auditan" },
  { title: "ANALISIS ASURANSI", findingsTitle: "Temuan Asuransi", aspectIds: ["asuransi"], sub: "Perlindungan Asuransi" },
  { title: "ANALISIS KETENAGAKERJAAN", findingsTitle: "Temuan Ketenagakerjaan", aspectIds: ["ketenagakerjaan"], sub: "Kepatuhan Ketenagakerjaan" },
  { title: "ANALISIS PERKARA", findingsTitle: "Temuan Perkara", aspectIds: ["perkara"], sub: "Perkara Perdata, Pidana dan Tata Usaha Negara" },
  { title: "ANALISIS PERJANJIAN DENGAN PIHAK KETIGA DAN AFILIASI", findingsTitle: "Temuan Perjanjian dengan Pihak Ketiga dan Afiliasi", aspectIds: ["perjanjian_penting"], sub: "Perjanjian dengan Pihak Ketiga dan Pihak Terafiliasi" },
];

/**
 * Build the chapter plan. Analysis chapters are included only when the entity
 * actually has material for them, so a report never carries an empty chapter —
 * except the corporate chapter, which is always present.
 *
 * `format` defaults to "pendahuluan_led" so omitting it reproduces today's
 * output byte-for-byte. `clientRole` and `transactionImplications` are
 * optional and only consulted by the newer formats / the sell-side override.
 */
export function planChapters(args: {
  transactionType: DDTransactionType;
  regime: DDRegime;
  presentAspects: DDAspectId[];
  format?: DDReportFormat;
  clientRole?: string;
  transactionImplications?: boolean;
}): DDChapterPlan[] {
  const { transactionType, regime, presentAspects, clientRole, transactionImplications } = args;
  const format: DDReportFormat = args.format ?? "pendahuluan_led";
  const present = new Set(presentAspects);
  const out: DDChapterPlan[] = [];
  const push = (kind: DDChapterKind, title: string, subs: DDChapterSub[], aspectIds: DDAspectId[] = []) => {
    out.push({ kind, numeral: "", title, aspectIds, subs });
  };

  const seller = isSellerRole(clientRole);
  const useSellSide = seller && (transactionType === "divestasi" || transactionType === "akuisisi_saham");

  const pushCapitalMarkets = () => {
    if (!regime.capitalMarkets) return;
    const viaParent = regime.parentTbkName !== null;
    push(
      "pasar_modal",
      viaParent ? "KEPATUHAN KETENTUAN PASAR MODAL PADA TINGKAT INDUK" : "KEPATUHAN KETENTUAN PASAR MODAL",
      viaParent
        ? [
            { title: "Kedudukan Perseroan terhadap Induk Berstatus Terbuka" },
            { title: "Pengujian Ambang Transaksi Material terhadap Induk" },
            { title: "Kewajiban yang Timbul pada Tingkat Induk" },
            { title: "Isu Kedalaman Rantai Perusahaan Terkendali" },
          ]
        : [
            { title: "Pengujian Ambang Transaksi Material" },
            { title: "Transaksi Afiliasi dan Benturan Kepentingan" },
            { title: "Pengambilalihan dan Penawaran Tender Wajib" },
            { title: "Kewajiban Keterbukaan Berkelanjutan" },
          ]
    );
  };

  const pushBumn = () => {
    if (!hasLayer(regime, "bumn")) return;
    push("bumn", "LAPISAN BADAN USAHA MILIK NEGARA", [{ title: "Pertanyaan yang Wajib Dijawab" }]);
  };

  const pushTransactionBlock = () => {
    if (useSellSide) {
      for (const t of sellSideChapters()) {
        push("transaksi_jual", t.title, t.subs.map((s) => ({ title: s })));
      }
      return;
    }
    for (const t of transactionChapters(transactionType)) {
      push("transaksi", t.title, t.subs.map((s) => ({ title: s })));
    }
  };

  if (format === "exec_summary_led") {
    push("ringkasan", "RINGKASAN EKSEKUTIF", []);

    for (const def of CATEGORY_CHAPTERS) {
      const always = def.aspectIds.indexOf("pendirian_ad") !== -1;
      if (!always && !def.aspectIds.some((a) => present.has(a))) continue;
      const subs: DDChapterSub[] = def.subs.map((s) => ({ title: s, aspectIds: def.aspectIds }));
      subs.push({ title: def.findingsTitle, aspectIds: def.aspectIds, findings: true });
      if (transactionImplications) subs.push(implicationSub(def.title, transactionType));
      push("kategori", def.title, subs, def.aspectIds);
    }

    pushTransactionBlock();
    pushCapitalMarkets();
    pushBumn();

    push("kesimpulan", "KESIMPULAN DAN REKOMENDASI", KESIMPULAN_SUBS);
    push("lampiran", "LAMPIRAN", LAMPIRAN_SUBS);
    push("disclaimer", "DISCLAIMER", []);
  } else if (format === "findings_only") {
    push("ringkasan", "RINGKASAN EKSEKUTIF", []);

    for (const aspectId of ASPECT_ORDER) {
      if (!present.has(aspectId)) continue;
      const label = ASPECT_LABELS[aspectId];
      push(
        "temuan",
        `TEMUAN — ${label}`,
        [{ title: label, aspectIds: [aspectId], findings: true }],
        [aspectId]
      );
    }

    push("rekomendasi", "REKOMENDASI DAN TINDAK LANJUT", KESIMPULAN_SUBS);
    push("lampiran", "LAMPIRAN", LAMPIRAN_SUBS);
    push("disclaimer", "DISCLAIMER", []);
  } else if (format === "lut_pasar_modal") {
    push("pendahuluan", "PENDAHULUAN", PENDAHULUAN_SUBS);

    for (const area of LUT_AREAS) {
      const always = area.aspectIds.indexOf("pendirian_ad") !== -1;
      if (!always && !area.aspectIds.some((a) => present.has(a))) continue;
      const subs: DDChapterSub[] = [
        { title: area.sub, aspectIds: area.aspectIds },
        { title: area.findingsTitle, aspectIds: area.aspectIds, findings: true },
      ];
      push("analisis_aspek", area.title, subs, area.aspectIds);
    }

    // A Tbk is bound by UUPT *and* the capital-markets overlay, so the UUPT
    // transaction block belongs here too. Omitting it would leave a Tbk report
    // with no UUPT compliance at all — RUPS quorum, the Pasal 127 announcement
    // and employee notice, the creditor objection window — which is the very
    // conflation between the two regimes this codebase exists to avoid.
    pushTransactionBlock();

    // Prescribed by HKHSK Annex VII regardless of the entity's own regime axis
    // — this format only exists because the target feeds a prospectus.
    push("pasar_modal", "KEPATUHAN KETENTUAN PASAR MODAL", [
      { title: "Pengujian Ambang Transaksi Material" },
      { title: "Transaksi Afiliasi dan Benturan Kepentingan" },
      { title: "Pengambilalihan dan Penawaran Tender Wajib" },
      { title: "Kewajiban Keterbukaan Berkelanjutan" },
    ]);

    push("kesimpulan", "KESIMPULAN DAN REKOMENDASI", KESIMPULAN_SUBS);
    push("lampiran", "LAMPIRAN", LAMPIRAN_SUBS);
    push("disclaimer", "DISCLAIMER", []);
  } else {
    // "pendahuluan_led" — unchanged from the original implementation.
    push("pendahuluan", "PENDAHULUAN", PENDAHULUAN_SUBS);
    push("profil", "PROFIL PERSEROAN", PROFIL_SUBS);

    for (const def of ASPECT_CHAPTERS) {
      const always = def.aspectIds.indexOf("pendirian_ad") !== -1;
      if (!always && !def.aspectIds.some((a) => present.has(a))) continue;
      const subs: DDChapterSub[] = def.subs.map((s) => ({ title: s, aspectIds: def.aspectIds }));
      subs.push({ title: def.findingsTitle, aspectIds: def.aspectIds, findings: true });
      push("analisis_aspek", def.title, subs, def.aspectIds);
    }

    pushTransactionBlock();
    pushCapitalMarkets();
    pushBumn();

    push("kesimpulan", "KESIMPULAN DAN REKOMENDASI", KESIMPULAN_SUBS);
    push("lampiran", "LAMPIRAN", LAMPIRAN_SUBS);
    push("disclaimer", "DISCLAIMER", []);
  }

  // Numerals cover the numbered chapters; LAMPIRAN and DISCLAIMER stand outside.
  let i = 0;
  for (const ch of out) {
    if (ch.kind === "lampiran" || ch.kind === "disclaimer") continue;
    ch.numeral = ROMAN[i] ?? String(i + 1);
    i++;
  }
  return out;
}

/** "1.4" / "7.1" — decimal sub-numbering as the house format uses. */
export function subNumber(chapterIndex: number, subIndex: number): string {
  return `${chapterIndex}.${subIndex + 1}`;
}

/** Which analysis chapter a finding belongs to, by aspect. */
export function chapterForAspect(
  plan: DDChapterPlan[],
  aspectId: DDAspectId
): DDChapterPlan | null {
  return plan.find((c) => c.kind === "analisis_aspek" && c.aspectIds.indexOf(aspectId) !== -1) ?? null;
}
