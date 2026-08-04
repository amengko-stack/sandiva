import { describe, it, expect } from "vitest";
import {
  deedCitation,
  deedShortName,
  renderNarrativeSectionI,
  DOCUMENT_NOT_AVAILABLE,
  type DDNarrativeBlock,
} from "@/lib/dd/narrative-render";
import type { DDDeedRef, DDNarrativeSectionI } from "@/types/dd";

const deed = (over: Partial<DDDeedRef> = {}): DDDeedRef => ({
  number: "16",
  dateISO: "2009-04-15",
  notary: "Raden Johanes Sarwono, S.H., Notaris di Jakarta",
  purpose: "pendirian",
  menkumhamRef: "Keputusan No. AHU-27282.AH.01.01.Tahun 2009 tanggal 27 Mei 2009",
  registrationRef: "No. 2172/BH.09.03/X/2009 tanggal 20 Oktober 2009",
  bnriRef: "No. 10 tanggal 17 Desember 2009, Tambahan No. 12302",
  sourceFile: "akta16.pdf",
  verbatim: "…didirikan…",
  ...over,
});

const base = (over: Partial<DDNarrativeSectionI> = {}): DDNarrativeSectionI => ({
  entityId: "e1",
  establishment: deed(),
  amendments: [],
  businessPurpose: "berusaha dalam bidang industri semen",
  businessActivities: [],
  businessBasis: "Akta No. 16/2009",
  capitalHistory: [],
  currentCapital: null,
  shareholders: [],
  directors: [],
  commissioners: [],
  notes: [],
  generatedAt: "2026-08-03T00:00:00.000Z",
  ...over,
});

const text = (blocks: DDNarrativeBlock[]) =>
  blocks
    .map((b) => (b.kind === "para" || b.kind === "heading" || b.kind === "note" ? b.text : JSON.stringify(b)))
    .join("\n");

describe("deedCitation", () => {
  it("weaves the full chain into one sentence, as the precedents do", () => {
    const s = deedCitation(deed(), { lead: "Akta Pendirian" });
    expect(s).toContain("Akta Pendirian No. 16 tanggal 15 April 2009");
    expect(s).toContain("Raden Johanes Sarwono");
    expect(s).toContain("AHU-27282.AH.01.01.Tahun 2009");
    expect(s).toContain("Daftar Perseroan");
    expect(s).toContain("Berita Negara Republik Indonesia");
    expect(s.endsWith(".")).toBe(true);
  });

  // Missing links are the reportable cases; they must be omitted silently from
  // the sentence rather than rendered as empty clauses or invented.
  it("omits links the documents do not supply, without leaving dangling clauses", () => {
    const s = deedCitation(
      deed({ menkumhamRef: "", registrationRef: "", bnriRef: "" }),
      { lead: "Akta" }
    );
    expect(s).toContain("Akta No. 16 tanggal 15 April 2009");
    expect(s).toContain("Raden Johanes Sarwono");
    expect(s).not.toContain("Menteri Hukum");
    expect(s).not.toContain("Berita Negara");
    expect(s).not.toMatch(/,\s*\./);
    expect(s).not.toMatch(/,\s*$/);
  });

  it("drops the deed's own date phrase when the date is illegible", () => {
    // Only the deed's own date is dropped — the Menkumham and Gazette
    // references legitimately carry their own dates.
    const s = deedCitation(deed({ dateISO: "" }), { lead: "Akta" });
    expect(s.startsWith('Akta No. 16 ("Akta No. 16")')).toBe(true);
    expect(s).not.toMatch(/^Akta No\. 16 tanggal/);
  });

  it("builds a short name usable for later cross-reference", () => {
    expect(deedShortName(deed())).toBe("Akta No. 16/2009");
    expect(deedShortName(deed({ dateISO: "" }))).toBe("Akta No. 16");
  });
});

describe("renderNarrativeSectionI", () => {
  it("opens Data Korporasi with the establishment deed's short name, not a checklist", () => {
    const blocks = renderNarrativeSectionI(base(), "PT Ciptanugrah Indonesia");
    const defs = blocks.find((b) => b.kind === "defs");
    expect(defs).toBeDefined();
    expect(JSON.stringify(defs)).toContain("Akta No. 16/2009");
    const out = text(blocks);
    // Working-paper vocabulary must not appear in the client narrative.
    expect(out).not.toContain("KRITIS");
    expect(out).not.toContain("Dokumen yang diharapkan");
    expect(out).not.toContain("TIDAK ADA");
    // No risk-level / severity vocabulary anywhere.
    expect(out).not.toMatch(/Tingkat Risiko/i);
    expect(out).not.toMatch(/\[T\]|\[S\]|\[R\]/);
    expect(out).not.toMatch(/\bkritis\b|\bminor\b/i);
  });

  it("marks the Riwayat table's Kemenkumham cell with the disclaimer marker when the deed has no reference", () => {
    const blocks = renderNarrativeSectionI(base({
      establishment: deed({ menkumhamRef: "", registrationRef: "" }),
    }), "PT Alpha");
    const table = blocks.find(
      (b) => b.kind === "table" && b.headers[0] === "No." && b.headers.includes("Status Kemenkumham")
    );
    expect(table).toBeDefined();
    expect(JSON.stringify(table)).toContain(DOCUMENT_NOT_AVAILABLE);
  });

  it("states the position honestly when the incorporation deed is absent", () => {
    const out = text(renderNarrativeSectionI(base({ establishment: null }), "PT Alpha"));
    expect(out).toContain("tidak termasuk dalam Dokumen Yang Diperiksa");
    expect(out).toContain("tidak dapat kami pastikan");
  });

  it("gives the Riwayat lead-in a count and states Kemenkumham registration, then a chronological table", () => {
    const blocks = renderNarrativeSectionI(base({
      amendments: [
        deed({ number: "17", dateISO: "2016-02-26", purpose: "perubahan Dewan Komisaris" }),
        deed({ number: "6", dateISO: "2019-07-24", purpose: "perubahan Pasal 3 mengenai maksud dan tujuan" }),
      ],
    }), "PT Alpha");
    const out = text(blocks);
    expect(out).toContain("3 kali tindakan korporasi");
    expect(out).toContain("Seluruh tindakan telah didaftarkan ke Kemenkumham");

    const table = blocks.find(
      (b) => b.kind === "table" && b.headers[0] === "No." && b.headers.includes("Status Kemenkumham")
    );
    expect(table).toBeDefined();
    if (table && table.kind === "table") {
      // Row 1 is the establishment deed; the establishment year (2009) precedes
      // the amendments (2016, then 2019) chronologically.
      expect(table.rows[0][1]).toBe("16");
      expect(table.rows[1][1]).toBe("17");
      expect(table.rows[2][1]).toBe("6");
      expect(table.rows[1][4]).toBe("perubahan Dewan Komisaris");
    }
  });

  it("says the establishment deed alone is row 1 when the articles were never amended", () => {
    const blocks = renderNarrativeSectionI(base(), "PT Alpha");
    const table = blocks.find(
      (b) => b.kind === "table" && b.headers[0] === "No." && b.headers.includes("Status Kemenkumham")
    );
    expect(table).toBeDefined();
    if (table && table.kind === "table") {
      expect(table.rows.length).toBe(1);
      expect(table.rows[0][1]).toBe("16");
    }
  });

  it("attaches each note to the passage it concerns, as an indented Catatan", () => {
    const blocks = renderNarrativeSectionI(base({
      notes: [
        { anchor: "permodalan", text: "Bukti penyetoran atas sisa modal belum tersedia.", sourceFile: null },
        { anchor: "pendirian", text: "Nama Perseroan dalam akta pendirian berbeda ejaannya.", sourceFile: "akta16.pdf" },
      ],
    }), "PT Alpha");
    const idxDataKorporasi = blocks.findIndex((b) => b.kind === "heading" && b.text === "Data Korporasi");
    const idxRiwayat = blocks.findIndex(
      (b) => b.kind === "heading" && b.text === "Riwayat Pendirian dan Perubahan Anggaran Dasar"
    );
    const noteIdx = blocks.findIndex((b) => b.kind === "note" && b.text.includes("berbeda ejaannya"));
    // The establishment note must sit inside the Data Korporasi sub-section.
    expect(noteIdx).toBeGreaterThan(idxDataKorporasi);
    expect(noteIdx).toBeLessThan(idxRiwayat);
  });

  it("renders an unresolvable note under its own heading rather than guessing a section", () => {
    const out = text(renderNarrativeSectionI(base({
      notes: [{ anchor: "lainnya", text: "Terdapat rujukan pada perjanjian yang tidak tersedia.", sourceFile: null }],
    }), "PT Alpha"));
    expect(out).toContain("Catatan Lain atas Aspek Korporasi");
  });

  it("presents capital as a definition list and shareholders as a table", () => {
    const blocks = renderNarrativeSectionI(base({
      currentCapital: {
        basis: "Akta No. 2/2017", authorized: "Rp 50.000.000", issued: "Rp 38.000.000",
        paidUp: "Rp 38.000.000", shareCount: "50.000", nominalPerShare: "Rp 1.000", sourceFile: "akta2.pdf",
      },
      shareholders: [
        { name: "PT Solusi Bangun Indonesia Tbk", shares: "37.999", amount: "Rp 37.999.000", percentage: "99,99%", sourceFile: "dps.pdf" },
      ],
    }), "PT Alpha");
    const defs = blocks.filter((b) => b.kind === "defs");
    expect(defs.some((d) => JSON.stringify(d).includes("Modal disetor"))).toBe(true);
    const table = blocks.find((b) => b.kind === "table" && b.headers[0] === "Pemegang Saham");
    expect(table).toBeDefined();
    expect(JSON.stringify(table)).toContain("PT Solusi Bangun Indonesia Tbk");
  });

  it("covers all six sub-sections in the house order", () => {
    const headings = renderNarrativeSectionI(base(), "PT Alpha")
      .filter((b) => b.kind === "heading")
      .map((b) => (b as { text: string }).text);
    expect(headings.slice(0, 6)).toEqual([
      "Data Korporasi",
      "Riwayat Pendirian dan Perubahan Anggaran Dasar",
      "Maksud, Tujuan dan Kegiatan Usaha",
      "Struktur Permodalan dan Pemegang Saham",
      "Susunan Direksi",
      "Susunan Dewan Komisaris",
    ]);
  });
});
