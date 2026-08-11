import { formatIndonesianDate } from "@/lib/dd/report-boilerplate";
import type {
  DDCapitalEntry, DDDeedRef, DDNarrativeNote, DDNarrativeSectionI, DDOfficerEntry,
} from "@/types/dd";

/**
 * Renders BAB II (Profil Perseroan) in the shape the user chose: a short
 * narrative lead-in sentence that summarises and counts, followed by a dense
 * table. This is the house pattern confirmed against
 * LDD_SIIB_Pembubaran_FINAL_v4.docx §2.2 "Riwayat Pendirian & Perubahan
 * Anggaran Dasar", §2.3 "Struktur Pemegang Saham", §3.5 "Temuan & Risiko
 * Korporasi" and §7.1.1 "Project Canyon".
 *
 * Deliberately NO risk-level column or severity label anywhere: the reference
 * report's "Tingkat Risiko [T]/[S]/[R]" column is that report's own house
 * invention, not an Indonesian LDD convention (verified against the other
 * Makarim precedents and the professional-standard notes, which use "Note:"
 * instead). The internal DDSeverity scale orders findings but is never
 * printed.
 *
 * Pure functions returning blocks of plain text, so the content is
 * unit-testable without building a .docx. The Word builder turns blocks into
 * paragraphs/tables.
 */
export type DDNarrativeBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "note"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "defs"; rows: [string, string][] }
  | { kind: "table"; headers: string[]; rows: string[][] };

const NO_DATA = "Dokumen Yang Diperiksa tidak memuat keterangan mengenai hal ini.";
/** Reused verbatim from the reference report's disclaimer marker. */
export const DOCUMENT_NOT_AVAILABLE = "[DOKUMEN TIDAK TERSEDIA]";
const DASH = "—";

/** Short form used to refer back to a deed once introduced, e.g. "Akta No. 16/2009". */
export function deedShortName(d: DDDeedRef): string {
  const year = d.dateISO.slice(0, 4);
  return year ? `Akta No. ${d.number}/${year}` : `Akta No. ${d.number}`;
}

/**
 * One sentence carrying as much of the chain as the documents support:
 * deed → notary → Menkumham → registration → State Gazette. Absent links are
 * omitted rather than papered over, because their absence is itself reportable.
 */
export function deedCitation(d: DDDeedRef, opts: { lead: string }): string {
  const dated = d.dateISO ? ` tanggal ${formatIndonesianDate(d.dateISO)}` : "";
  const parts: string[] = [`${opts.lead} No. ${d.number}${dated} ("${deedShortName(d)}")`];
  if (d.notary) parts.push(`yang dibuat di hadapan ${d.notary}`);
  if (d.menkumhamRef) {
    parts.push(
      `telah memperoleh pengesahan/persetujuan dari Menteri Hukum dan Hak Asasi Manusia Republik Indonesia berdasarkan ${d.menkumhamRef}`
    );
  }
  if (d.registrationRef) parts.push(`didaftarkan dalam Daftar Perseroan berdasarkan ${d.registrationRef}`);
  if (d.bnriRef) parts.push(`serta diumumkan dalam Berita Negara Republik Indonesia ${d.bnriRef}`);
  return `${parts.join(", ")}.`;
}

/** Kemenkumham cell for one row of the Riwayat table: SK/SP references, or the disclaimer marker. */
function kemenkumhamStatus(d: DDDeedRef): string {
  const parts: string[] = [];
  if (d.menkumhamRef) parts.push(d.menkumhamRef);
  if (d.registrationRef) parts.push(d.registrationRef);
  if (parts.length === 0) return DOCUMENT_NOT_AVAILABLE;
  return parts.join("; ");
}

function deedTableRow(no: number, d: DDDeedRef): string[] {
  return [
    String(no),
    d.number || DASH,
    d.dateISO ? formatIndonesianDate(d.dateISO) : DASH,
    d.notary || DASH,
    d.purpose || DASH,
    kemenkumhamStatus(d),
  ];
}

function notesFor(notes: DDNarrativeNote[], anchor: DDNarrativeNote["anchor"]): DDNarrativeBlock[] {
  const mine = notes.filter((n) => n.anchor === anchor);
  if (mine.length === 0) return [];
  if (mine.length === 1) {
    return [{ kind: "note", text: mine[0].text }];
  }
  // Several qualifications on one passage read better enumerated.
  return [
    { kind: "note", text: "" },
    { kind: "list", items: mine.map((n) => n.text) },
  ];
}

function capitalDefs(c: DDCapitalEntry): [string, string][] {
  const rows: [string, string][] = [
    ["Modal dasar", c.authorized || DASH],
    ["Modal ditempatkan", c.issued || DASH],
    ["Modal disetor", c.paidUp || DASH],
  ];
  if (c.shareCount || c.nominalPerShare) {
    rows.push([
      "Klasifikasi saham",
      `${c.shareCount || DASH} saham dengan nilai nominal ${c.nominalPerShare || DASH} per saham`,
    ]);
  }
  return rows;
}

function officerTable(list: DDOfficerEntry[], label: string): DDNarrativeBlock[] {
  if (list.length === 0) {
    return [{ kind: "para", text: `${NO_DATA} (${label})` }];
  }
  return [
    {
      kind: "table",
      headers: ["Jabatan", "Nama", "Diangkat berdasarkan", "Masa jabatan"],
      rows: list.map((o) => [o.role, o.name, o.appointedBy || DASH, o.termUntil || "tidak dinyatakan"]),
    },
  ];
}

export function renderNarrativeSectionI(
  n: DDNarrativeSectionI,
  entityName: string
): DDNarrativeBlock[] {
  const out: DDNarrativeBlock[] = [];
  const P = `"Perseroan"`;

  // --- 1. Data Korporasi ---
  out.push({ kind: "heading", text: "Data Korporasi" });
  const dataKorporasiRows: [string, string][] = [["Nama", entityName]];
  if (n.establishment) {
    dataKorporasiRows.push([
      "Tanggal pendirian",
      n.establishment.dateISO ? formatIndonesianDate(n.establishment.dateISO) : DASH,
    ]);
    dataKorporasiRows.push(["Dasar pendirian", deedShortName(n.establishment)]);
  } else {
    dataKorporasiRows.push(["Tanggal pendirian", DOCUMENT_NOT_AVAILABLE]);
    dataKorporasiRows.push(["Dasar pendirian", DOCUMENT_NOT_AVAILABLE]);
  }
  dataKorporasiRows.push(["Status", "Tertutup"]);
  out.push({ kind: "defs", rows: dataKorporasiRows });
  out.push(...notesFor(n.notes, "pendirian"));

  // --- 2. Riwayat Pendirian dan Perubahan Anggaran Dasar ---
  out.push({ kind: "heading", text: "Riwayat Pendirian dan Perubahan Anggaran Dasar" });
  const deeds: DDDeedRef[] = [];
  if (n.establishment) deeds.push(n.establishment);
  deeds.push(...n.amendments);
  if (deeds.length === 0) {
    out.push({
      kind: "para",
      text:
        `${entityName} (${P}) merupakan perseroan terbatas yang didirikan menurut hukum Republik Indonesia. ` +
        `Akta pendirian Perseroan beserta keputusan pengesahannya tidak termasuk dalam Dokumen Yang Diperiksa, ` +
        `sehingga tanggal perolehan status badan hukum Perseroan tidak dapat kami pastikan.`,
    });
  } else {
    const allRegistered = deeds.every((d) => Boolean(d.menkumhamRef) || Boolean(d.registrationRef));
    const count = deeds.length;
    const countLabel = count === 1 ? "satu kali tindakan korporasi" : `${count} kali tindakan korporasi`;
    out.push({
      kind: "para",
      text:
        `Sejak pendirian Perseroan hingga tanggal cut-off Laporan, telah dilakukan ${countLabel} berupa pendirian ` +
        `dan/atau perubahan Anggaran Dasar. ` +
        (allRegistered
          ? `Seluruh tindakan telah didaftarkan ke Kemenkumham. `
          : `Tidak seluruh tindakan tersebut dapat kami pastikan telah didaftarkan ke Kemenkumham. `) +
        `Rincian sebagai berikut:`,
    });
    out.push({
      kind: "table",
      headers: ["No.", "Akta No.", "Tanggal", "Notaris", "Perubahan Material", "Status Kemenkumham"],
      rows: deeds.map((d, i) => deedTableRow(i + 1, d)),
    });
  }
  out.push(...notesFor(n.notes, "anggaran_dasar"));

  // --- 3. Maksud, Tujuan dan Kegiatan Usaha ---
  out.push({ kind: "heading", text: "Maksud, Tujuan dan Kegiatan Usaha" });
  if (n.businessPurpose) {
    out.push({
      kind: "para",
      text:
        `${n.businessBasis ? `Berdasarkan ${n.businessBasis}, m` : "M"}aksud dan tujuan Perseroan adalah ${n.businessPurpose}.` +
        (n.businessActivities.length > 0
          ? " Untuk mencapai maksud dan tujuan tersebut, Perseroan dapat melaksanakan kegiatan usaha sebagai berikut:"
          : ""),
    });
  } else {
    out.push({ kind: "para", text: NO_DATA });
  }
  if (n.businessActivities.length > 0) {
    out.push({ kind: "list", items: n.businessActivities });
  }
  out.push(...notesFor(n.notes, "kegiatan_usaha"));

  // --- 4. Struktur Permodalan dan Pemegang Saham ---
  out.push({ kind: "heading", text: "Struktur Permodalan dan Pemegang Saham" });
  if (n.currentCapital) {
    out.push({
      kind: "para",
      text:
        `Pada tanggal Laporan ini, struktur permodalan Perseroan${n.currentCapital.basis ? ` sebagaimana termuat dalam ${n.currentCapital.basis}` : ""} adalah sebagai berikut:`,
    });
    out.push({ kind: "defs", rows: capitalDefs(n.currentCapital) });
  } else {
    out.push({ kind: "para", text: NO_DATA });
  }
  if (n.capitalHistory.length > 1) {
    out.push({
      kind: "para",
      text: "Riwayat permodalan Perseroan berdasarkan Dokumen Yang Diperiksa adalah sebagai berikut:",
    });
    out.push({
      kind: "table",
      headers: ["Dasar", "Modal dasar", "Modal ditempatkan", "Modal disetor"],
      rows: n.capitalHistory.map((c) => [c.basis || DASH, c.authorized || DASH, c.issued || DASH, c.paidUp || DASH]),
    });
  }
  out.push(...notesFor(n.notes, "permodalan"));
  if (n.shareholders.length > 0) {
    out.push({
      kind: "para",
      text: "Susunan pemegang saham Perseroan berdasarkan Dokumen Yang Diperiksa adalah sebagai berikut:",
    });
    out.push({
      kind: "table",
      headers: ["Pemegang Saham", "Jumlah Saham", "Nilai Nominal", "Persentase"],
      rows: n.shareholders.map((s) => [s.name, s.shares || DASH, s.amount || DASH, s.percentage || DASH]),
    });
  } else {
    out.push({ kind: "para", text: NO_DATA });
  }
  out.push(...notesFor(n.notes, "pemegang_saham"));

  // --- 5. Susunan Direksi ---
  out.push({ kind: "heading", text: "Susunan Direksi" });
  out.push({
    kind: "para",
    text: "Susunan anggota Direksi Perseroan berdasarkan Dokumen Yang Diperiksa adalah sebagai berikut:",
  });
  out.push(...officerTable(n.directors, "Direksi"));
  out.push(...notesFor(n.notes, "pengurus"));

  // --- 6. Susunan Dewan Komisaris ---
  out.push({ kind: "heading", text: "Susunan Dewan Komisaris" });
  out.push({
    kind: "para",
    text: "Susunan anggota Dewan Komisaris Perseroan berdasarkan Dokumen Yang Diperiksa adalah sebagai berikut:",
  });
  out.push(...officerTable(n.commissioners, "Dewan Komisaris"));

  // Qualifications whose sub-section could not be resolved are shown here under
  // their own heading rather than guessed into one of the sections above.
  const orphans = n.notes.filter((x) => x.anchor === "lainnya");
  if (orphans.length > 0) {
    out.push({ kind: "heading", text: "Catatan Lain atas Aspek Korporasi" });
    out.push({ kind: "list", items: orphans.map((x) => x.text) });
  }

  return out;
}
