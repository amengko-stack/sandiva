import type { DDAspectId, DDRegime, DDTransactionType } from "@/types/dd";
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
  | "disclaimer";

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

/**
 * Build the chapter plan. Analysis chapters are included only when the entity
 * actually has material for them, so a report never carries an empty chapter —
 * except the corporate chapter, which is always present.
 */
export function planChapters(args: {
  transactionType: DDTransactionType;
  regime: DDRegime;
  presentAspects: DDAspectId[];
}): DDChapterPlan[] {
  const { transactionType, regime, presentAspects } = args;
  const present = new Set(presentAspects);
  const out: DDChapterPlan[] = [];
  const push = (kind: DDChapterKind, title: string, subs: DDChapterSub[], aspectIds: DDAspectId[] = []) => {
    out.push({ kind, numeral: "", title, aspectIds, subs });
  };

  push("pendahuluan", "PENDAHULUAN", PENDAHULUAN_SUBS);
  push("profil", "PROFIL PERSEROAN", PROFIL_SUBS);

  for (const def of ASPECT_CHAPTERS) {
    const always = def.aspectIds.indexOf("pendirian_ad") !== -1;
    if (!always && !def.aspectIds.some((a) => present.has(a))) continue;
    const subs: DDChapterSub[] = def.subs.map((s) => ({ title: s, aspectIds: def.aspectIds }));
    subs.push({ title: def.findingsTitle, aspectIds: def.aspectIds, findings: true });
    push("analisis_aspek", def.title, subs, def.aspectIds);
  }

  for (const t of transactionChapters(transactionType)) {
    push("transaksi", t.title, t.subs.map((s) => ({ title: s })));
  }

  if (regime.capitalMarkets) {
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
  }

  if (hasLayer(regime, "bumn")) {
    push("bumn", "LAPISAN BADAN USAHA MILIK NEGARA", [
      { title: "Pertanyaan yang Wajib Dijawab" },
    ]);
  }

  push("kesimpulan", "KESIMPULAN DAN REKOMENDASI", KESIMPULAN_SUBS);
  push("lampiran", "LAMPIRAN", LAMPIRAN_SUBS);
  push("disclaimer", "DISCLAIMER", []);

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
