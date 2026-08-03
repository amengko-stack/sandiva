import type {
  DDComplianceVerdict,
  DDEntity,
  DDFindingReviewStatus,
  DDRegime,
  DDReportMeta,
  DDSeverity,
  DDTransaction,
} from "@/types/dd";
import { transactionLabel } from "@/config/ddTransactionTypes";

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const INDONESIAN_MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/** "2026-07-22" -> "22 Juli 2026". Returns the input unchanged if it doesn't parse. */
export function formatIndonesianDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return iso;
  }
  const year = match[1];
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const month = INDONESIAN_MONTHS[monthIndex];
  if (!month || Number.isNaN(day)) {
    return iso;
  }
  return `${day} ${month} ${year}`;
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const PLACEHOLDER = {
  matterRef: "[NOMOR REFERENSI]",
  clientName: "[NAMA KLIEN]",
  addressee: "[PIHAK YANG DITUJU]",
  relianceScope: "[PIHAK YANG DAPAT MENGANDALKAN LAPORAN INI]",
  ddStartDateISO: "[TANGGAL MULAI UJI TUNTAS]",
};

function metaOrPlaceholder(meta: DDReportMeta | undefined): {
  matterRef: string;
  clientName: string;
  addressee: string;
  relianceScope: string;
  ddStartDate: string;
} {
  if (!meta) {
    return {
      matterRef: PLACEHOLDER.matterRef,
      clientName: PLACEHOLDER.clientName,
      addressee: PLACEHOLDER.addressee,
      relianceScope: PLACEHOLDER.relianceScope,
      ddStartDate: PLACEHOLDER.ddStartDateISO,
    };
  }
  return {
    matterRef: meta.matterRef || PLACEHOLDER.matterRef,
    clientName: meta.clientName || PLACEHOLDER.clientName,
    addressee: meta.addressee || PLACEHOLDER.addressee,
    relianceScope: meta.relianceScope || PLACEHOLDER.relianceScope,
    ddStartDate: meta.ddStartDateISO ? formatIndonesianDate(meta.ddStartDateISO) : PLACEHOLDER.ddStartDateISO,
  };
}

// ---------------------------------------------------------------------------
// A-E opening parts
// ---------------------------------------------------------------------------

export interface DDBoilerplateParams {
  transaction: DDTransaction;
  entity: DDEntity;
  regime: DDRegime;
  meta: DDReportMeta;
}

export interface DDBoilerplateBlock {
  letter: string; // "A".."E"
  heading: string; // heading text WITHOUT the letter prefix
  body: string[]; // one entry per paragraph, no leading/trailing blank entries, no markdown
}

/** A. Lingkup dan Dasar Penugasan */
export function openingScope(params: {
  transaction: DDTransaction;
  entity: DDEntity;
  meta?: DDReportMeta;
}): DDBoilerplateBlock {
  const { transaction, entity, meta } = params;
  const m = metaOrPlaceholder(meta);
  const txnLabel = transactionLabel(transaction.type);
  return {
    letter: "A",
    heading: "Lingkup dan Dasar Penugasan",
    body: [
      `Laporan Uji Tuntas Dari Segi Hukum ini ("Laporan") disusun berdasarkan instruksi ${m.clientName} ` +
        `kepada firma hukum untuk melaksanakan uji tuntas dari segi hukum (legal due diligence) sehubungan dengan ` +
        `rencana ${txnLabel} yang melibatkan ${entity.name} ("Perseroan"), dengan nomor referensi ${m.matterRef}.`,
      `Laporan ini dan setiap Pendapat Hukum (legal opinion) yang disusun berdasarkan uji tuntas yang sama merupakan ` +
        `satu kesatuan yang tidak dapat dipisahkan, dan wajib dibaca serta ditafsirkan bersama-sama.`,
    ],
  };
}

/** B. Dokumen Yang Diperiksa dan Tanggal Akhir Uji Tuntas */
export function openingDocuments(params: {
  transaction: DDTransaction;
  meta?: DDReportMeta;
}): DDBoilerplateBlock {
  const { transaction, meta } = params;
  const m = metaOrPlaceholder(meta);
  const cutoff = transaction.cutoffDateISO
    ? formatIndonesianDate(transaction.cutoffDateISO)
    : "[TANGGAL AKHIR UJI TUNTAS]";
  return {
    letter: "B",
    heading: "Dokumen Yang Diperiksa dan Tanggal Akhir Uji Tuntas",
    body: [
      `Istilah "Dokumen Yang Diperiksa" dalam Laporan ini berarti seluruh dokumen, akta, perizinan, perjanjian, ` +
        `catatan, dan keterangan tertulis lain yang disediakan oleh atau atas nama Perseroan melalui ruang data ` +
        `(data room) untuk keperluan uji tuntas ini, sebagaimana diidentifikasi dalam Laporan. Pemeriksaan ` +
        `dilaksanakan dalam periode yang dimulai pada ${m.ddStartDate}.`,
      `Istilah "Tanggal Akhir Uji Tuntas" berarti ${cutoff}, yaitu tanggal cut-off formal pemeriksaan ini. ` +
        `Tidak ada peristiwa, dokumen, atau perubahan keadaan yang terjadi setelah Tanggal Akhir Uji Tuntas yang ` +
        `diperiksa atau tercakup dalam Laporan ini.`,
    ],
  };
}

const ASSUMPTIONS_RINGKAS = [
  "berdasarkan Pasal 1338 Kitab Undang-Undang Hukum Perdata, setiap perjanjian yang dibuat dengan itikad baik mengikat sebagai undang-undang bagi para pihak yang membuatnya, sepanjang tidak bertentangan dengan ketentuan yang bersifat memaksa (dwingend recht) dan ketertiban umum",
  "pemeriksaan hanya dilakukan atas hal-hal yang secara tegas dinyatakan dalam Dokumen Yang Diperiksa; tidak ada hal yang diperiksa secara tersirat atau diasumsikan ada di luar apa yang secara tegas dinyatakan",
  "seluruh tanda tangan pada Dokumen Yang Diperiksa adalah asli, salinan sesuai dengan aslinya, dan pihak yang menandatangani telah memperoleh kewenangan yang sah untuk melakukannya",
  "seluruh data dan keterangan yang disampaikan kepada firma hukum adalah benar, akurat, lengkap, dan tidak berubah sampai dengan Tanggal Akhir Uji Tuntas",
];

const ASSUMPTIONS_PANJANG = [
  "berdasarkan Pasal 1338 Kitab Undang-Undang Hukum Perdata, setiap perjanjian yang dibuat dengan itikad baik mengikat sebagai undang-undang bagi para pihak yang membuatnya, sepanjang tidak bertentangan dengan ketentuan yang bersifat memaksa (dwingend recht) dan ketertiban umum",
  "pemeriksaan hanya dilakukan atas hal-hal yang secara tegas dinyatakan dalam Dokumen Yang Diperiksa; tidak ada hal yang diperiksa secara tersirat atau diasumsikan ada di luar apa yang secara tegas dinyatakan",
  "seluruh tanda tangan pada Dokumen Yang Diperiksa adalah asli, dan setiap salinan yang diperiksa sesuai dengan aslinya",
  "setiap pihak yang menandatangani Dokumen Yang Diperiksa telah memperoleh kewenangan dan kapasitas yang sah untuk melakukannya, termasuk persetujuan korporasi internal yang disyaratkan",
  "seluruh data dan keterangan yang disampaikan kepada firma hukum adalah benar, akurat, lengkap, dan tidak berubah sampai dengan Tanggal Akhir Uji Tuntas",
  "tidak terdapat perjanjian, kesepakatan, atau pengaturan tambahan (side agreement) antara Perseroan dan pihak ketiga yang tidak diungkapkan dalam Dokumen Yang Diperiksa",
  "setiap akta notaris yang diperiksa dibuat secara sah sesuai dengan ketentuan hukum yang berlaku dan oleh notaris yang berwenang pada saat pembuatannya",
  "daftar pemegang saham dan daftar khusus Perseroan yang diperiksa mencerminkan keadaan kepemilikan saham dan kepentingan Direksi/Dewan Komisaris yang sebenarnya dan akurat",
  "tidak terdapat pembebanan, jaminan, atau hak pihak ketiga lain atas harta kekayaan Perseroan selain yang diungkapkan dalam Dokumen Yang Diperiksa",
  "ruang data (data room) yang disediakan lengkap dan tidak ada dokumen material yang ditahan atau tidak diungkapkan",
  "tidak terdapat tindakan, pemeriksaan, atau rencana tindakan oleh instansi pemerintah atau regulator terhadap Perseroan yang belum diungkapkan",
];

/** C. Asumsi */
export function openingAssumptions(variant: "ringkas" | "panjang"): DDBoilerplateBlock {
  if (variant === "ringkas") {
    const markers = ["i", "ii", "iii", "iv"];
    return {
      letter: "C",
      heading: "Asumsi",
      body: ASSUMPTIONS_RINGKAS.map((text, i) => `(${markers[i]}) ${text}`),
    };
  }
  const letters = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
  return {
    letter: "C",
    heading: "Asumsi",
    body: ASSUMPTIONS_PANJANG.map((text, i) => `(${letters[i]}) ${text}`),
  };
}

/** D. Pembatasan */
export function openingQualifications(): DDBoilerplateBlock {
  return {
    letter: "D",
    heading: "Pembatasan",
    body: [
      `Pemeriksaan yang menjadi dasar Laporan ini tidak mencakup kebenaran data keuangan, teknis, atau komersial ` +
        `Perseroan, maupun kewajaran (fairness) komersial dari transaksi yang direncanakan. Pendapat Hukum yang ` +
        `disusun berdasarkan Laporan ini tidak boleh ditafsirkan sebagai pendapat mengenai kewajaran komersial ` +
        `transaksi.`,
      `Sesuai dengan doktrin pembedaan antara aspek yuridis formal dan aspek yuridis material, kebenaran aspek ` +
        `material diasumsikan berdasarkan pernyataan dan jaminan (representations and warranties) manajemen ` +
        `Perseroan; asumsi inilah yang menjadi dasar hukum bagi tanda "[PERLU VERIFIKASI]" yang muncul pada ` +
        `bagian tubuh Laporan ini.`,
      `Laporan ini tidak memuat pernyataan yang bersifat prediktif (forward-looking) dan tidak menyatakan ` +
        `pendapat di luar kompetensi firma hukum sebagai konsultan hukum Indonesia.`,
    ],
  };
}

/** E. Ketentuan Keterandalan */
export function openingReliance(params: { meta?: DDReportMeta }): DDBoilerplateBlock {
  const m = metaOrPlaceholder(params.meta);
  return {
    letter: "E",
    heading: "Ketentuan Keterandalan",
    body: [
      `Laporan ini disusun semata-mata untuk ${m.clientName} untuk tujuan yang dinyatakan dalam Laporan ini, ` +
        `dan hanya dapat diandalkan oleh ${m.relianceScope}. Pihak lain di luar itu tidak berhak mengandalkan ` +
        `Laporan ini untuk keperluan apa pun.`,
      `Laporan ini tidak boleh dikutip atau diungkapkan kepada pihak ketiga mana pun tanpa persetujuan tertulis ` +
        `terlebih dahulu dari firma hukum, kecuali sepanjang diwajibkan oleh hukum yang berlaku.`,
    ],
  };
}

/** A–E in order, from one shared params object, so the builder has a single call site. */
export function openingBlocks(params: DDBoilerplateParams): DDBoilerplateBlock[] {
  const { transaction, entity, meta } = params;
  return [
    openingScope({ transaction, entity, meta }),
    openingDocuments({ transaction, meta }),
    openingAssumptions(meta.assumptionsVariant),
    openingQualifications(),
    openingReliance({ meta }),
  ];
}

// ---------------------------------------------------------------------------
// Other boilerplate
// ---------------------------------------------------------------------------

export function scopeExclusionNote(taxInScope: boolean): string {
  if (taxInScope) {
    return (
      `Pemeriksaan sebagaimana diuraikan di atas tidak mencakup kebenaran data keuangan, teknis, atau komersial ` +
      `Perseroan.`
    );
  }
  return (
    `Pemeriksaan sebagaimana diuraikan di atas tidak mencakup kebenaran data keuangan, teknis, atau komersial ` +
    `Perseroan, dan tidak mencakup aspek perpajakan, yang berada di luar lingkup penugasan ini.`
  );
}

export function confidentialityLegend(): string {
  return "RAHASIA DAN DILINDUNGI HAK ISTIMEWA — HANYA UNTUK PIHAK YANG BERHAK MENGANDALKAN LAPORAN INI";
}

export function draftLegend(): string {
  return "DRAF — TIDAK UNTUK DIEDARKAN";
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export function verdictLabel(v: DDComplianceVerdict): string {
  switch (v) {
    case "memenuhi":
      return "memenuhi ketentuan";
    case "memenuhi_dengan_catatan":
      return "memenuhi ketentuan dengan catatan";
    case "tidak_memenuhi":
      return "tidak memenuhi ketentuan";
    default:
      return v;
  }
}

export interface DDVerdictInput {
  severity: DDSeverity;
  status: DDFindingReviewStatus;
}

/** Pure tri-state helper. Ignores dismissed findings. */
export function deriveVerdict(findings: DDVerdictInput[]): DDComplianceVerdict {
  const active = findings.filter((f) => f.status !== "dismissed");
  if (active.some((f) => f.severity === "kritis")) {
    return "tidak_memenuhi";
  }
  if (active.some((f) => f.severity === "material" || f.severity === "minor")) {
    return "memenuhi_dengan_catatan";
  }
  return "memenuhi";
}
