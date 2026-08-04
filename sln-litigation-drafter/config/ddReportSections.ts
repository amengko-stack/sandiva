import type { DDAspectId, DDRegime, DDRegimeLayer, DDTransactionType } from "@/types/dd";
import { hasLayer } from "@/lib/dd/regime";

export interface DDReportSection {
  id: string; // "I".."VIII"
  numeral: string; // "I", "II", …
  title: string;
  aspectIds: DDAspectId[]; // [] for VII and VIII
  subsections: string[];
}

export const DD_REPORT_SECTIONS: DDReportSection[] = [
  {
    id: "I",
    numeral: "I",
    title: "Pendirian, Anggaran Dasar dan Riwayat Korporasi",
    aspectIds: ["pendirian_ad", "permodalan_saham", "pengurus"],
    subsections: [
      "Pendirian",
      "Anggaran Dasar dan Perubahannya",
      "Ketentuan Penting dalam Anggaran Dasar",
      "Riwayat Permodalan dan Pemegang Saham",
      "Daftar Pemegang Saham dan Daftar Khusus",
      "Direksi dan Dewan Komisaris",
      "Rapat Umum Pemegang Saham dan Risalah",
    ],
  },
  {
    id: "II",
    numeral: "II",
    title: "Perizinan dan Pemenuhan Kewajiban",
    aspectIds: ["perizinan", "perpajakan"],
    subsections: [
      "Nomor Induk Berusaha dan Perizinan Berbasis Risiko",
      "Perizinan Sektoral",
      "Perizinan Lingkungan dan Bangunan",
      "Kewajiban Perpajakan",
    ],
  },
  {
    id: "III",
    numeral: "III",
    title: "Harta Kekayaan dan Asuransi",
    aspectIds: ["harta_kekayaan", "asuransi"],
    subsections: [
      "Harta Tidak Bergerak",
      "Harta Bergerak",
      "Pembebanan dan Jaminan",
      "Perlindungan Asuransi",
    ],
  },
  {
    id: "IV",
    numeral: "IV",
    title: "Perjanjian-Perjanjian Penting dengan Pihak Ketiga",
    aspectIds: ["perjanjian_penting"],
    subsections: [
      "Perjanjian Kredit dan Pembiayaan",
      "Perjanjian Usaha dan Komersial",
      "Perjanjian dengan Pihak Terafiliasi",
      "Ketentuan yang Terpicu oleh Transaksi",
    ],
  },
  {
    id: "V",
    numeral: "V",
    title: "Ketenagakerjaan",
    aspectIds: ["ketenagakerjaan"],
    subsections: [
      "Peraturan Perusahaan atau Perjanjian Kerja Bersama",
      "Perjanjian Kerja dan Struktur Tenaga Kerja",
      "Upah Minimum dan Jaminan Sosial",
      "Serikat Pekerja dan Perselisihan",
    ],
  },
  {
    id: "VI",
    numeral: "VI",
    title: "Perkara dan Sengketa",
    aspectIds: ["perkara"],
    subsections: [
      "Perkara yang Melibatkan Perseroan",
      "Pernyataan Perseroan",
      "Pernyataan Direksi dan Dewan Komisaris",
    ],
  },
  {
    id: "VII",
    numeral: "VII",
    title: "Kepatuhan Aspek Transaksi",
    aspectIds: [],
    subsections: [
      "Ketentuan Undang-Undang Perseroan Terbatas",
      "Ketentuan Pasar Modal",
      "Ketentuan Badan Usaha Milik Negara",
    ],
  },
  {
    id: "VIII",
    numeral: "VIII",
    title: "Kesimpulan",
    aspectIds: [],
    subsections: [],
  },
];

// Built once by iterating DD_REPORT_SECTIONS so the map can never drift from
// the section list above.
const ASPECT_TO_SECTION: Partial<Record<DDAspectId, DDReportSection>> = {};
for (const section of DD_REPORT_SECTIONS) {
  for (const aspectId of section.aspectIds) {
    ASPECT_TO_SECTION[aspectId] = section;
  }
}

/** Total function — every DDAspectId maps to a section. No fallback/throw path is reachable. */
export function sectionForAspect(aspectId: DDAspectId): DDReportSection {
  const section = ASPECT_TO_SECTION[aspectId];
  if (section) {
    return section;
  }
  // Unreachable given DD_REPORT_SECTIONS covers all 10 aspect ids; kept only
  // to satisfy the compiler's control-flow analysis.
  return DD_REPORT_SECTIONS[0];
}

/** I..VIII in order. VII is always present (VII.A applies to every regime). */
export function sectionsForRegime(_regime: DDRegime): DDReportSection[] {
  return DD_REPORT_SECTIONS;
}

const VII_SUBSECTIONS: { id: string; title: string; layer: DDRegimeLayer }[] = [
  { id: "VII.A", title: "Ketentuan Undang-Undang Perseroan Terbatas", layer: "uupt" },
  { id: "VII.B", title: "Ketentuan Pasar Modal", layer: "pasar_modal_langsung" },
  { id: "VII.C", title: "Ketentuan Badan Usaha Milik Negara", layer: "bumn" },
];

/**
 * Which VII sub-sections apply for this regime. VII.A always applies
 * (baseline UUPT layer). VII.B applies when the entity is itself Tbk or
 * carries the Tbk-parent overlay — the label is generic ("Ketentuan Pasar
 * Modal") but the underlying obligation table differs (see regime.ts:
 * pasar_modal_langsung vs pasar_modal_induk); the boilerplate/body builder
 * is responsible for choosing the right table. VII.C applies only under the
 * BUMN layer.
 */
export function regimeSubsectionsForVII(
  regime: DDRegime
): { id: string; title: string; layer: DDRegimeLayer }[] {
  return VII_SUBSECTIONS.filter((sub) => {
    if (sub.layer === "uupt") {
      return true;
    }
    if (sub.layer === "pasar_modal_langsung") {
      return hasLayer(regime, "pasar_modal_langsung") || hasLayer(regime, "pasar_modal_induk");
    }
    return hasLayer(regime, sub.layer);
  });
}

export interface DDViiAFraming {
  heading: string;
  framing: string;
}

/**
 * Per-transaction-type heading + framing sentence for VII.A. "streamlining"
 * and "joint_venture" have no bespoke statutory sequence in UUPT (they are
 * not one of the fundamental-action procedures in Pasal 122-137) — their
 * framing is deliberately generic rather than invented.
 */
export const DD_VII_A_FRAMING: Record<DDTransactionType, DDViiAFraming> = {
  akuisisi_saham: {
    heading: "Kepatuhan Prosedur Pengambilalihan Saham",
    framing:
      "Bagian ini menguji kepatuhan rencana pengambilalihan saham Perseroan terhadap prosedur pengambilalihan yang diatur dalam Undang-Undang Perseroan Terbatas, termasuk persetujuan RUPS, rancangan pengambilalihan, pengumuman, dan hak kreditor serta pemegang saham yang tidak setuju.",
  },
  akuisisi_aset: {
    heading: "Kepatuhan Prosedur Pengalihan Kekayaan Perseroan",
    framing:
      "Bagian ini menguji kepatuhan rencana pengalihan aset Perseroan terhadap ketentuan Undang-Undang Perseroan Terbatas mengenai pengalihan kekayaan, termasuk kebutuhan persetujuan RUPS apabila pengalihan tersebut melebihi 50% dari kekayaan bersih Perseroan.",
  },
  merger: {
    heading: "Kepatuhan Prosedur Penggabungan",
    framing:
      "Bagian ini menguji kepatuhan rencana penggabungan terhadap prosedur penggabungan yang diatur dalam Undang-Undang Perseroan Terbatas, termasuk rancangan penggabungan, persetujuan RUPS, pengumuman, dan hak kreditor serta pemegang saham yang tidak setuju.",
  },
  likuidasi: {
    heading: "Kepatuhan Prosedur Pembubaran dan Likuidasi",
    framing:
      "Bagian ini menguji kepatuhan rencana pembubaran Perseroan terhadap prosedur likuidasi yang diatur dalam Undang-Undang Perseroan Terbatas, termasuk pengumuman pembubaran oleh likuidator dan jangka waktu pengajuan tagihan oleh kreditor.",
  },
  divestasi: {
    heading: "Kepatuhan Prosedur Divestasi",
    framing:
      "Bagian ini menguji kepatuhan rencana divestasi terhadap ketentuan Undang-Undang Perseroan Terbatas yang relevan dengan pelepasan penyertaan, termasuk persetujuan RUPS untuk tindakan fundamental dan hak pemegang saham yang tidak setuju.",
  },
  streamlining: {
    heading: "Kepatuhan Aspek Korporasi Reorganisasi Grup",
    framing:
      "Undang-Undang Perseroan Terbatas tidak menyediakan satu prosedur baku untuk streamlining atau reorganisasi grup sebagai kategori tersendiri; kepatuhan diuji terhadap ketentuan umum Perseroan Terbatas yang relevan dengan langkah korporasi yang sebenarnya ditempuh (misalnya perubahan anggaran dasar, pengalihan kekayaan, atau penggabungan), sesuai dengan bentuk konkret transaksi ini.",
  },
  joint_venture: {
    heading: "Kepatuhan Aspek Korporasi Usaha Patungan",
    framing:
      "Undang-Undang Perseroan Terbatas tidak menyediakan satu prosedur baku untuk pembentukan usaha patungan sebagai kategori tersendiri; kepatuhan diuji terhadap ketentuan umum Perseroan Terbatas yang relevan dengan langkah korporasi yang sebenarnya ditempuh (misalnya penambahan modal, perubahan anggaran dasar, atau pengalihan saham), sesuai dengan struktur konkret usaha patungan ini.",
  },
};
