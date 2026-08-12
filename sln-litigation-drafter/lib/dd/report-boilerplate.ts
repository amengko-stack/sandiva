import type {
  DDComplianceVerdict,
  DDEntity,
  DDFindingReviewStatus,
  DDRegime,
  DDReportMeta,
  DDSeverity,
  DDSupplementDiff,
  DDTransaction,
} from "@/types/dd";
import { transactionLabel } from "@/config/ddTransactionTypes";
import { supplementIsWarranted } from "@/lib/dd/supplement";

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
  /** Requested documents not yet supplied. Named in an interim report. */
  outstanding?: string[];
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
    ].concat(outstandingParagraphs(params.meta, params.outstanding ?? [])),
  };
}

/** Beyond this the paragraph stops being readable; the remainder is in the body. */
const OUTSTANDING_LISTED = 12;

/**
 * The paragraph an interim report owes its reader: what is still outstanding.
 *
 * Naming the documents is the point. "This report is interim" without saying what
 * is missing gives the reader no way to judge how much weight the conclusions can
 * carry. The list comes from the gap analysis, so it is the same set the report
 * already treats as missing — stated once, up front, where a reader decides how
 * far to trust the rest.
 */
export function outstandingParagraphs(
  meta: DDReportMeta | undefined,
  outstanding: string[]
): string[] {
  if (meta === undefined || meta.reportStage !== "interim") return [];
  if (outstanding.length === 0) {
    return [
      `Laporan ini bersifat interim. Pada Tanggal Akhir Uji Tuntas, penyerahan dokumen oleh Perseroan belum ` +
        `dinyatakan selesai, sehingga kesimpulan dalam Laporan ini dapat berubah setelah dokumen selanjutnya ` +
        `diperiksa.`,
    ];
  }
  const listed = outstanding.slice(0, OUTSTANDING_LISTED);
  const rest = outstanding.length - listed.length;
  const tail =
    rest > 0 ? `; dan ${rest} dokumen lain yang diuraikan pada bagian tubuh Laporan ini` : "";
  return [
    `Laporan ini bersifat interim. Sampai dengan Tanggal Akhir Uji Tuntas terdapat ${outstanding.length} ` +
      `dokumen atau kelompok dokumen yang diminta namun belum tersedia atau belum lengkap, yaitu: ` +
      `${listed.join("; ")}${tail}.`,
    `Kesimpulan dalam Laporan ini disusun semata-mata atas dasar Dokumen Yang Diperiksa sampai dengan Tanggal ` +
      `Akhir Uji Tuntas dan bersifat sementara. Setelah dokumen yang belum tersedia diperiksa, kesimpulan ` +
      `tersebut dapat berubah, dan perubahannya dituangkan dalam laporan tambahan (supplement) atau dalam ` +
      `laporan final yang menggantikan Laporan ini.`,
  ];
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

/**
 * An interim report cannot assume the data room is complete.
 *
 * The standard assumption set says the data room was complete and nothing material
 * was withheld, and that the information supplied is complete. In an interim report
 * that is a direct contradiction: chapter 1.4 names the documents that were
 * requested and have not arrived. Left in, the report would assume away the very
 * limitation it states, and an assumption of completeness is exactly what a reader
 * would rely on when deciding how much weight the conclusions carry.
 *
 * The assumption is not dropped, it is replaced with the true one: what was
 * supplied is assumed accurate, and completeness is expressly not assumed.
 */
const INTERIM_ASSUMPTION_SUBSTITUTIONS: { match: RegExp; replacement: string }[] = [
  {
    match: /ruang data \(data room\) yang disediakan lengkap/,
    replacement:
      "ruang data (data room) yang disediakan BELUM dinyatakan lengkap pada Tanggal Akhir Uji Tuntas; kelengkapannya tidak diasumsikan, dan dokumen yang belum tersedia diuraikan dalam Laporan ini",
  },
  {
    match: /benar, akurat, lengkap, dan tidak berubah/,
    replacement:
      "benar dan akurat sepanjang isinya serta tidak berubah, namun TIDAK diasumsikan lengkap karena penyerahan dokumen belum selesai",
  },
];

function forStage(text: string, stage: DDReportMeta["reportStage"]): string {
  if (stage !== "interim") return text;
  for (const s of INTERIM_ASSUMPTION_SUBSTITUTIONS) {
    if (s.match.test(text)) return text.replace(s.match, s.replacement);
  }
  return text;
}

/** C. Asumsi */
export function openingAssumptions(
  variant: "ringkas" | "panjang",
  stage: DDReportMeta["reportStage"] = "final"
): DDBoilerplateBlock {
  if (variant === "ringkas") {
    const markers = ["i", "ii", "iii", "iv"];
    return {
      letter: "C",
      heading: "Asumsi",
      body: ASSUMPTIONS_RINGKAS.map((text, i) => `(${markers[i]}) ${forStage(text, stage)}`),
    };
  }
  const letters = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
  return {
    letter: "C",
    heading: "Asumsi",
    body: ASSUMPTIONS_PANJANG.map((text, i) => `(${letters[i]}) ${forStage(text, stage)}`),
  };
}

/** D. Pembatasan */
export function openingQualifications(
  stage: DDReportMeta["reportStage"] = "final"
): DDBoilerplateBlock {
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
    ].concat(
      // An interim report must refuse the uses that assume a closed examination.
      // Saying only "this is interim" leaves the reader to work out the
      // consequence, and the consequence is the part that protects them.
      stage === "interim"
        ? [
            `Laporan ini merupakan laporan interim dan bukan hasil pemeriksaan yang telah selesai. Laporan ini ` +
              `tidak boleh dijadikan dasar tunggal bagi keputusan penyelesaian transaksi (closing), penetapan ` +
              `harga, atau perumusan pernyataan dan jaminan (representations and warranties) dalam dokumen ` +
              `transaksi.`,
          ]
        : []
    ),
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
    ].concat(
      // Reliance is what the report is for, so an interim one has to narrow it
      // rather than repeat the full clause and hope the reader notices the title.
      params.meta !== undefined && params.meta.reportStage === "interim"
        ? [
            `Karena Laporan ini bersifat interim, keterandalan atasnya terbatas pada penggunaan internal oleh ` +
              `${m.clientName} untuk keperluan pengambilan keputusan sementara. Keterandalan bagi pihak lain, ` +
              `termasuk pihak yang disebut di atas, baru berlaku atas laporan final.`,
          ]
        : []
    ),
  };
}

/** A–E in order, from one shared params object, so the builder has a single call site. */
export function openingBlocks(
  params: DDBoilerplateParams,
  outstanding: string[] = []
): DDBoilerplateBlock[] {
  const { transaction, entity, meta } = params;
  return [
    openingScope({ transaction, entity, meta }),
    openingDocuments({ transaction, meta, outstanding }),
    openingAssumptions(meta.assumptionsVariant, meta.reportStage),
    openingQualifications(meta.reportStage),
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

/**
 * The report's own title, which has to say when the examination is unfinished.
 *
 * Someone picking the document up months later has the cover and nothing else to
 * tell them whether its conclusions were provisional.
 */
export function reportTitle(stage: DDReportMeta["reportStage"]): string {
  return stage === "interim"
    ? "LAPORAN UJI TUNTAS DARI SEGI HUKUM (INTERIM)"
    : "LAPORAN UJI TUNTAS DARI SEGI HUKUM";
}

export function interimLegend(): string {
  return "LAPORAN INTERIM — PEMERIKSAAN BELUM SELESAI, KESIMPULAN DAPAT BERUBAH";
}

/**
 * The sentence that must accompany any money figure in the report.
 *
 * A dissolution LDD cannot avoid figures: whether the estate covers the claims
 * decides the legal route, and UUPT Pasal 150's payment order is meaningless
 * without knowing what there is to pay with. But the report states in its own
 * qualifications that the examination does not cover the truth of financial data,
 * and a lawyer opining on valuation is outside their competence.
 *
 * The rule the user chose: a figure may be REPEATED from a document that states
 * it, with the source named, and the legal consequence may be reasoned from it. A
 * figure may never be valued, computed, or estimated by the report itself, and
 * every figure carries the statement that an accountant must verify it.
 *
 * That keeps the report inside UUPT Pasal 149's terms — the liquidator inventories,
 * the lawyer says what follows in law — without the firm opining on value.
 */
export function financialFigureQualification(): string {
  return (
    "Seluruh angka pada bagian ini dikutip dari dokumen yang disebutkan sebagai sumbernya dan " +
    "merupakan estimasi yang WAJIB diverifikasi oleh akuntan atau auditor. Pemeriksaan ini adalah " +
    "pemeriksaan hukum: kami tidak menilai kewajaran, tidak melakukan valuasi, dan tidak menghitung " +
    "sendiri angka mana pun. Kesimpulan hukum yang ditarik dari angka tersebut hanya berlaku sepanjang " +
    "angkanya benar."
  );
}

/**
 * What the report may say when solvency cannot be determined from the documents.
 *
 * Silence would be the wrong answer: a dissolution report that says nothing about
 * solvency reads as though the estate is adequate. The absence has to be stated as
 * an absence.
 */
export function solvencyUndeterminedNote(): string {
  return (
    "Dokumen Yang Diperiksa tidak memuat data yang cukup untuk menyatakan apakah harta Perseroan " +
    "mencukupi seluruh kewajibannya. Hal ini WAJIB dipastikan sebelum pembubaran dilaksanakan: apabila " +
    "harta tidak mencukupi, penyelesaian tidak dapat ditempuh melalui likuidasi berdasarkan UUPT " +
    "Pasal 142 dan seterusnya, melainkan melalui kepailitan, dan urutan pembayaran menurut UUPT " +
    "Pasal 150 menjadi persoalan mengenai kreditor mana yang tidak terbayar. [PERLU VERIFIKASI]"
  );
}

export function supplementTitle(): string {
  return "LAPORAN TAMBAHAN (SUPPLEMENT) ATAS LAPORAN UJI TUNTAS DARI SEGI HUKUM";
}

/**
 * The clause that makes a supplement work as a legal instrument.
 *
 * Following the precedent, a supplement does not restate or replace the report it
 * follows: it is read together with it, and only what it says is changed is
 * changed. Saying that explicitly is what stops a reader treating the supplement
 * as a standalone report — which would be the worst outcome, since a supplement
 * on its own describes a fraction of the examination and would read as if that
 * fraction were the whole of it.
 */
export function supplementIncorporation(params: {
  meta: DDReportMeta;
  /** Cut-off date of the report being supplemented. */
  baselineCutoffISO: string;
  /** Cut-off date of this supplement. */
  cutoffISO: string;
}): string[] {
  const before = params.baselineCutoffISO
    ? formatIndonesianDate(params.baselineCutoffISO)
    : "[TANGGAL AKHIR UJI TUNTAS LAPORAN SEBELUMNYA]";
  const now = params.cutoffISO
    ? formatIndonesianDate(params.cutoffISO)
    : "[TANGGAL AKHIR UJI TUNTAS LAPORAN TAMBAHAN INI]";
  const m = metaOrPlaceholder(params.meta);
  return [
    `Laporan Tambahan (Supplement) ini merupakan tambahan atas Laporan Uji Tuntas Dari Segi Hukum dengan ` +
      `nomor referensi ${m.matterRef} yang Tanggal Akhir Uji Tuntasnya ${before} ("Laporan Sebelumnya"). ` +
      `Laporan Tambahan ini dan Laporan Sebelumnya merupakan satu kesatuan yang tidak dapat dipisahkan dan ` +
      `wajib dibaca serta ditafsirkan bersama-sama.`,
    `Laporan Tambahan ini TIDAK menggantikan dan tidak mengulang Laporan Sebelumnya. Uraian, asumsi, ` +
      `pembatasan, dan ketentuan keterandalan dalam Laporan Sebelumnya tetap berlaku sepenuhnya, kecuali ` +
      `sepanjang secara tegas diubah dalam Laporan Tambahan ini. Hal yang tidak disebut dalam Laporan ` +
      `Tambahan ini berarti tidak berubah.`,
    `Laporan Tambahan ini memuat hasil pemeriksaan atas dokumen yang TIDAK termasuk dalam pemeriksaan ` +
      `Laporan Sebelumnya, sebagaimana diperiksa sampai dengan ${now}, yaitu Tanggal Akhir Uji Tuntas ` +
      `Laporan Tambahan ini. Kami tidak menyatakan kapan dokumen tersebut diterima; yang kami nyatakan ` +
      `adalah dokumen tersebut belum tercakup dalam pemeriksaan sampai dengan ${before}. Peristiwa atau ` +
      `dokumen setelah ${now} tidak diperiksa.`,
  ];
}

/**
 * Why a supplement must not be issued, or "" when it may be.
 *
 * A supplement with nothing to report would be a document that says nothing while
 * presenting itself as an addition to a report the client relies on — and it would
 * suggest the examination moved when it did not.
 */
export function supplementBlocker(diff: DDSupplementDiff): string {
  if (supplementIsWarranted(diff)) return "";
  return (
    "Laporan Tambahan tidak dapat diterbitkan: dibandingkan laporan sebelumnya, tidak ada dokumen baru " +
    "yang diperiksa, tidak ada perubahan pada daftar dokumen yang belum tersedia, dan tidak ada perubahan " +
    "pada temuan. Jalankan ulang ekstraksi dan analisis setelah dokumen tambahan diunggah, atau terbitkan " +
    "laporan final."
  );
}

/**
 * Why a client release must be refused, or "" when it may proceed.
 *
 * The existing gate catches a release with nobody named as entitled to rely on it.
 * This adds the converse: a report going out as FINAL while documents it asked for
 * were never supplied. Both are cases where the cover asserts something the body
 * cannot support. Both remain the lawyer's call to override — by issuing the report
 * as interim, or by marking those checklist items not applicable if they are never
 * coming.
 */
export function finalReleaseBlocker(meta: DDReportMeta, outstandingCount: number): string {
  if (!meta.clientRelease) return "";
  if (meta.relianceScope.trim() === "") {
    return "Ekspor sebagai laporan final untuk klien diblokir: Ruang Lingkup Keterandalan (reliance scope) belum diisi pada Tahap 1. Isi kolom tersebut atau matikan opsi rilis ke klien.";
  }
  if (meta.reportStage === "final" && outstandingCount > 0) {
    return (
      `Ekspor sebagai laporan final untuk klien diblokir: masih terdapat ${outstandingCount} dokumen yang ` +
      `diminta namun belum tersedia atau belum lengkap. Terbitkan sebagai laporan interim, atau tandai dokumen ` +
      `tersebut sebagai tidak berlaku (not applicable) pada checklist bila memang tidak akan diserahkan.`
    );
  }
  return "";
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
