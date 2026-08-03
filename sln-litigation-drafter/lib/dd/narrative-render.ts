import { formatIndonesianDate } from "@/lib/dd/report-boilerplate";
import type {
  DDCapitalEntry, DDDeedRef, DDNarrativeNote, DDNarrativeSectionI, DDOfficerEntry,
} from "@/types/dd";

/**
 * Renders Bagian I as the firm's precedents write it: a description of what the
 * documents say, with the citation chain woven into the sentence, and
 * qualifications raised as an indented "Catatan:" attached to the passage they
 * concern — not as a severity-tagged finding in a separate list.
 *
 * Pure functions returning blocks of plain text, so the prose is unit-testable
 * without building a .docx. The Word builder turns blocks into paragraphs.
 */
export type DDNarrativeBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "note"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "defs"; rows: [string, string][] }
  | { kind: "table"; headers: string[]; rows: string[][] };

const NO_DATA = "Dokumen Yang Diperiksa tidak memuat keterangan mengenai hal ini.";

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
    ["Modal dasar", c.authorized || "—"],
    ["Modal ditempatkan", c.issued || "—"],
    ["Modal disetor", c.paidUp || "—"],
  ];
  if (c.shareCount || c.nominalPerShare) {
    rows.push([
      "Klasifikasi saham",
      `${c.shareCount || "—"} saham dengan nilai nominal ${c.nominalPerShare || "—"} per saham`,
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
      rows: list.map((o) => [o.role, o.name, o.appointedBy || "—", o.termUntil || "tidak dinyatakan"]),
    },
  ];
}

export function renderNarrativeSectionI(
  n: DDNarrativeSectionI,
  entityName: string
): DDNarrativeBlock[] {
  const out: DDNarrativeBlock[] = [];
  const P = `"Perseroan"`;

  // --- 1. Pendirian ---
  out.push({ kind: "heading", text: "Pendirian" });
  if (n.establishment) {
    out.push({
      kind: "para",
      text:
        `${entityName} (${P}) didirikan berdasarkan ` +
        deedCitation(n.establishment, { lead: "Akta Pendirian" }),
    });
  } else {
    out.push({
      kind: "para",
      text:
        `${entityName} (${P}) merupakan perseroan terbatas yang didirikan menurut hukum Republik Indonesia. ` +
        `Akta pendirian Perseroan beserta keputusan pengesahannya tidak termasuk dalam Dokumen Yang Diperiksa, ` +
        `sehingga tanggal perolehan status badan hukum Perseroan tidak dapat kami pastikan.`,
    });
  }
  out.push(...notesFor(n.notes, "pendirian"));

  // --- 2. Anggaran Dasar dan Perubahannya ---
  out.push({ kind: "heading", text: "Anggaran Dasar dan Perubahannya" });
  if (n.amendments.length === 0) {
    out.push({
      kind: "para",
      text:
        `Berdasarkan Dokumen Yang Diperiksa, anggaran dasar Perseroan tidak pernah diubah sejak pendiriannya.`,
    });
  } else {
    const last = n.amendments[n.amendments.length - 1];
    out.push({
      kind: "para",
      text:
        `Anggaran dasar Perseroan telah mengalami ${n.amendments.length} kali perubahan, ` +
        `terakhir dengan ${deedShortName(last)}${last.dateISO ? ` tanggal ${formatIndonesianDate(last.dateISO)}` : ""}. ` +
        `Riwayat perubahan anggaran dasar Perseroan adalah sebagai berikut:`,
    });
    for (const a of n.amendments) {
      out.push({
        kind: "para",
        text:
          deedCitation(a, { lead: "Akta" }) +
          (a.purpose ? ` Perubahan tersebut mengenai ${a.purpose}.` : ""),
      });
    }
  }
  out.push(...notesFor(n.notes, "anggaran_dasar"));

  // --- 3. Maksud, Tujuan dan Kegiatan Usaha ---
  out.push({ kind: "heading", text: "Maksud, Tujuan dan Kegiatan Usaha" });
  if (n.businessPurpose) {
    out.push({
      kind: "para",
      text:
        `${n.businessBasis ? `Berdasarkan ${n.businessBasis}, m` : "M"}aksud dan tujuan Perseroan adalah ${n.businessPurpose}.`,
    });
  } else {
    out.push({ kind: "para", text: NO_DATA });
  }
  if (n.businessActivities.length > 0) {
    out.push({
      kind: "para",
      text: "Untuk mencapai maksud dan tujuan tersebut, Perseroan dapat melaksanakan kegiatan usaha sebagai berikut:",
    });
    out.push({ kind: "list", items: n.businessActivities });
  }
  out.push(...notesFor(n.notes, "kegiatan_usaha"));

  // --- 4. Permodalan ---
  out.push({ kind: "heading", text: "Permodalan" });
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
      rows: n.capitalHistory.map((c) => [c.basis || "—", c.authorized || "—", c.issued || "—", c.paidUp || "—"]),
    });
  }
  out.push(...notesFor(n.notes, "permodalan"));

  // --- 5. Pemegang Saham ---
  out.push({ kind: "heading", text: "Pemegang Saham" });
  if (n.shareholders.length > 0) {
    out.push({
      kind: "para",
      text: "Susunan pemegang saham Perseroan berdasarkan Dokumen Yang Diperiksa adalah sebagai berikut:",
    });
    out.push({
      kind: "table",
      headers: ["Pemegang Saham", "Jumlah Saham", "Nilai Nominal", "Persentase"],
      rows: n.shareholders.map((s) => [s.name, s.shares || "—", s.amount || "—", s.percentage || "—"]),
    });
  } else {
    out.push({ kind: "para", text: NO_DATA });
  }
  out.push(...notesFor(n.notes, "pemegang_saham"));

  // --- 6. Direksi dan Dewan Komisaris ---
  out.push({ kind: "heading", text: "Direksi dan Dewan Komisaris" });
  out.push({
    kind: "para",
    text: "Susunan anggota Direksi Perseroan berdasarkan Dokumen Yang Diperiksa adalah sebagai berikut:",
  });
  out.push(...officerTable(n.directors, "Direksi"));
  out.push({
    kind: "para",
    text: "Susunan anggota Dewan Komisaris Perseroan adalah sebagai berikut:",
  });
  out.push(...officerTable(n.commissioners, "Dewan Komisaris"));
  out.push(...notesFor(n.notes, "pengurus"));

  // Qualifications whose sub-section could not be resolved are shown here under
  // their own heading rather than guessed into one of the sections above.
  const orphans = n.notes.filter((x) => x.anchor === "lainnya");
  if (orphans.length > 0) {
    out.push({ kind: "heading", text: "Catatan Lain atas Aspek Korporasi" });
    out.push({ kind: "list", items: orphans.map((x) => x.text) });
  }

  return out;
}
