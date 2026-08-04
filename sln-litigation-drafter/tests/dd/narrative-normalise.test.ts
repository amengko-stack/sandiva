import { describe, it, expect } from "vitest";
import { citationNotes, dedupeDeeds, normaliseMarkers, shortenCapitalBasis } from "@/lib/dd/narrative";
import type { DDDeedRef } from "@/types/dd";

// Every case below is taken from the 2026-08-03 live run against the real data
// room, so these guard defects that actually reached a generated report rather
// than hypothetical ones.

const deed = (over: Partial<DDDeedRef> = {}): DDDeedRef => ({
  number: "17", dateISO: "2016-02-26", notary: "Devi Yunanda, S.H., M.Kn.",
  purpose: "Penyesuaian seluruh Anggaran Dasar", menkumhamRef: "", registrationRef: "",
  bnriRef: "", sourceFile: "a.pdf", verbatim: "",
  ...over,
});

describe("dedupeDeeds", () => {
  // The data room keeps some deeds twice (a "BN" copy and an "SP" copy). The
  // model emitted one row per source file, so Akta No. 17 appeared twice and the
  // lead-in counted 12 corporate actions where there were 11.
  it("merges the same deed appearing in two source files into one entry", () => {
    const out = dedupeDeeds([
      deed({ sourceFile: "PAD DK & BN.pdf", purpose: "Penyesuaian seluruh Anggaran Dasar; penetapan susunan pemegang saham" }),
      deed({ sourceFile: "PAD DK & SP.pdf", purpose: "Penyesuaian seluruh Anggaran Dasar (dokumen sumber kedua)" }),
    ]);
    expect(out).toHaveLength(1);
    // The substantive description wins over the "(dokumen sumber kedua)" aside.
    expect(out[0].purpose).toContain("penetapan susunan pemegang saham");
  });

  it("keeps the richest citation chain when merging", () => {
    const out = dedupeDeeds([
      deed({ menkumhamRef: "", registrationRef: "" }),
      deed({ menkumhamRef: "SK AHU-0003662", registrationRef: "AHU-0019467", bnriRef: "BNRI No. 10" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].menkumhamRef).toBe("SK AHU-0003662");
    expect(out[0].registrationRef).toBe("AHU-0019467");
    expect(out[0].bnriRef).toBe("BNRI No. 10");
  });

  it("fills gaps from the other copy rather than losing them", () => {
    const out = dedupeDeeds([
      deed({ menkumhamRef: "SK AHU-1", registrationRef: "", notary: "" }),
      deed({ menkumhamRef: "", registrationRef: "AHU-2", notary: "Devi Yunanda, S.H., M.Kn." }),
    ]);
    expect(out[0].menkumhamRef).toBe("SK AHU-1");
    expect(out[0].registrationRef).toBe("AHU-2");
    expect(out[0].notary).toBe("Devi Yunanda, S.H., M.Kn.");
  });

  it("treats a different number or date as a different deed", () => {
    expect(dedupeDeeds([deed(), deed({ number: "14" })])).toHaveLength(2);
    expect(dedupeDeeds([deed(), deed({ dateISO: "2016-12-14" })])).toHaveLength(2);
  });

  it("ignores leading zeros, since the same deed appeared as both 2 and 02", () => {
    expect(dedupeDeeds([deed({ number: "2" }), deed({ number: "02" })])).toHaveLength(1);
  });

  it("preserves input order and tolerates an empty list", () => {
    const out = dedupeDeeds([deed({ number: "9", dateISO: "2016-02-10" }), deed(), deed({ number: "14", dateISO: "2016-12-14" })]);
    expect(out.map((d) => d.number)).toEqual(["9", "17", "14"]);
    expect(dedupeDeeds([])).toEqual([]);
  });
});

describe("shortenCapitalBasis", () => {
  // Live output put a whole paragraph in this cell, making the capital table
  // unreadable. The notary and Menkumham chain already appear in the deed table.
  it("reduces a paragraph to the deed reference", () => {
    expect(
      shortenCapitalBasis(
        "Akta No. 2 tanggal 07 Februari 2017 (Devi Yunanda, SH., M.Kn.), disetujui Kemenkumham No. AHU-0003662.AH.01.02.TAHUN 2017 tanggal 10 Februari 2017"
      )
    ).toBe("Akta No. 2/2017");
  });

  it("handles the em-dash confirmation form seen live", () => {
    expect(
      shortenCapitalBasis(
        "Akta No. 6 tanggal 24 Juli 2019 (Ernita Meilani, S.H., LL.M., M.Kn.) — dikonfirmasi dalam DPS tanggal 13 Oktober 2020"
      )
    ).toBe("Akta No. 6/2019");
  });

  it("leaves an already-short reference untouched", () => {
    expect(shortenCapitalBasis("Akta No. 17/2016")).toBe("Akta No. 17/2016");
    expect(shortenCapitalBasis("Akta No. 2/2017")).toBe("Akta No. 2/2017");
  });

  it("does not invent a reference when there is no deed to find", () => {
    const odd = "Berdasarkan keterangan manajemen yang belum dapat kami verifikasi terhadap dokumen apa pun";
    expect(shortenCapitalBasis(odd).length).toBeLessThanOrEqual(40);
    expect(shortenCapitalBasis(odd)).not.toContain("Akta");
    expect(shortenCapitalBasis("")).toBe("");
  });
});

describe("normaliseMarkers", () => {
  // The report uses exactly two markers. The model invented a third live:
  // "[TIDAK DITEMUKAN — tidak ada akta pengangkatan dalam dokumen yang diperiksa]".
  it("maps an invented not-found marker to the document-unavailable marker", () => {
    expect(normaliseMarkers("[TIDAK DITEMUKAN — tidak ada akta pengangkatan dalam dokumen yang diperiksa]"))
      .toBe("[DOKUMEN TIDAK TERSEDIA]");
  });

  it("maps verification variants to the single verification marker", () => {
    expect(normaliseMarkers("status [BELUM DIVERIFIKASI] per cut-off")).toBe("status [PERLU VERIFIKASI] per cut-off");
    expect(normaliseMarkers("[PERLU DIVERIFIKASI terhadap AHU]")).toBe("[PERLU VERIFIKASI]");
  });

  it("leaves the two canonical markers and ordinary text alone", () => {
    expect(normaliseMarkers("[DOKUMEN TIDAK TERSEDIA]")).toBe("[DOKUMEN TIDAK TERSEDIA]");
    expect(normaliseMarkers("[PERLU VERIFIKASI]")).toBe("[PERLU VERIFIKASI]");
    expect(normaliseMarkers("Akta No. 16 tanggal 15 April 2009")).toBe("Akta No. 16 tanggal 15 April 2009");
  });

  it("normalises every occurrence, not just the first", () => {
    const out = normaliseMarkers("a [TIDAK DITEMUKAN] b [TIDAK DITEMUKAN — x] c");
    expect(out).toBe("a [DOKUMEN TIDAK TERSEDIA] b [DOKUMEN TIDAK TERSEDIA] c");
  });
});

// A reference number the report states must be findable in the examined documents.
// Only a number found NOWHERE is reported: one traced to another examined document
// is legitimate, since a deed's Menkumham decree number is routinely read off a
// later shareholder register rather than off the deed itself.
describe("citationNotes", () => {
  const deed = (over: Partial<DDDeedRef> = {}): DDDeedRef => ({
    number: "16", dateISO: "2009-04-15", notary: "", purpose: "Pendirian",
    menkumhamRef: "", registrationRef: "", bnriRef: "",
    sourceFile: "akta16.pdf", verbatim: "", ...over,
  });

  const corpus = (own: string, other?: string) => {
    const m = new Map<string, string>([["akta16.pdf", own]]);
    if (other) m.set("dps.pdf", other);
    return m;
  };

  it("says nothing when the reference is in the deed's own document", () => {
    const out = citationNotes(
      [deed({ menkumhamRef: "AHU-27282.AH.01.01.Tahun 2009" })],
      corpus("Akta 16 disahkan AHU-27282.AH.01.01.Tahun 2009")
    );
    expect(out).toEqual([]);
  });

  it("says nothing when the reference is in another examined document", () => {
    const out = citationNotes(
      [deed({ menkumhamRef: "AHU-27282.AH.01.01.Tahun 2009" })],
      corpus("Akta Pendirian Nomor 16", "riwayat: AHU-27282.AH.01.01.Tahun 2009")
    );
    expect(out).toEqual([]);
  });

  it("raises a note naming each reference found nowhere", () => {
    const out = citationNotes(
      [deed({ menkumhamRef: "AHU-99999.AH.01.02.TAHUN 2019", bnriRef: "BNRI No. 4321 Tambahan 8765" })],
      corpus("Akta Pendirian Nomor 16 tanggal 15 April 2009")
    );
    expect(out).toHaveLength(1);
    expect(out[0].anchor).toBe("anggaran_dasar");
    expect(out[0].text).toContain("AHU-99999.AH.01.02.TAHUN 2019");
    expect(out[0].text).toContain("BNRI No. 4321 Tambahan 8765");
    expect(out[0].text).toContain("Akta No. 16");
    expect(out[0].text).toContain("wajib diverifikasi");
  });

  it("ignores empty links rather than reporting them as untraceable", () => {
    expect(citationNotes([deed()], corpus("apa pun"))).toEqual([]);
  });

  it("reports per deed, so several bad deeds give several notes", () => {
    const out = citationNotes(
      [
        deed({ number: "16", menkumhamRef: "AHU-11111.AH.01.02.TAHUN 2011" }),
        deed({ number: "17", menkumhamRef: "AHU-22222.AH.01.02.TAHUN 2012" }),
      ],
      corpus("tidak memuat rujukan apa pun")
    );
    expect(out).toHaveLength(2);
  });
});

// The DDDeedRef type comment promises "every entry keeps its source file and a
// verbatim quote so no sentence in the report is unattributable". The quote was
// carried and never checked, so the promise was only half kept. The notary name is
// checked too: a live run had a shareholder register whose OCR read "Emili!
// Meilani" where the deed itself says ERNITA MEILANI five times, and an invented
// notary would otherwise reach the deed table as fact.
describe("citationNotes: notary name and underlying quote", () => {
  const deed = (over: Partial<DDDeedRef> = {}): DDDeedRef => ({
    number: "16", dateISO: "2009-04-15", notary: "", purpose: "Pendirian",
    menkumhamRef: "", registrationRef: "", bnriRef: "",
    sourceFile: "akta16.pdf", verbatim: "", ...over,
  });
  const room = (own: string, other?: string) => {
    const m = new Map<string, string>([["akta16.pdf", own]]);
    if (other) m.set("dps.pdf", other);
    return m;
  };

  it("raises a note when the notary named appears in no examined document", () => {
    const out = citationNotes(
      [deed({ notary: "Raden Johanes Sarwono, S.H." })],
      room("Akta Pendirian Nomor 16 dibuat di hadapan Musa Muamarta, S.H.")
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("Raden Johanes Sarwono");
    expect(out[0].text).toContain("Nama notaris");
  });

  // Matching the whole string would fail whenever the deed spells the degrees out,
  // which is common, and a false accusation is worse than no check.
  it("matches on the name alone, so spelled-out degrees are not a false absence", () => {
    const out = citationNotes(
      [deed({ notary: "Devi Yunanda, S.H., M.Kn." })],
      room("Berhadapan dengan saya, DEVI YUNANDA, Sarjana Hukum, Magister Kenotariatan")
    );
    expect(out).toEqual([]);
  });

  it("accepts a notary named only in another examined document", () => {
    const out = citationNotes(
      [deed({ notary: "Ernita Meilani, S.H., LL.M." })],
      room("Akta Nomor 16", "riwayat: dibuat di hadapan Ernita Meilani, SH, LL.M")
    );
    expect(out).toEqual([]);
  });

  it("raises a note when the quote behind the row is not in the document it names", () => {
    const out = citationNotes(
      [deed({ verbatim: "Perseroan telah memperoleh persetujuan Menteri atas perubahan ini" })],
      room("Akta Pendirian Nomor 16 tanggal 15 April 2009, dibuat di hadapan notaris.")
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("Kutipan yang mendasari uraian Akta No. 16");
    expect(out[0].text).toContain("akta16.pdf");
  });

  it("says nothing when the quote is genuinely in the document", () => {
    const out = citationNotes(
      [deed({ verbatim: "dibuat di hadapan Musa Muamarta" })],
      room("Akta Pendirian Nomor 16, dibuat di hadapan Musa Muamarta, S.H., Notaris di Jakarta.")
    );
    expect(out).toEqual([]);
  });

  // One note per deed listing everything wrong with it, rather than three notes
  // about the same row.
  it("combines every problem with one deed into a single note", () => {
    const out = citationNotes(
      [deed({
        notary: "Notaris Fiktif",
        menkumhamRef: "AHU-99999.AH.01.02.TAHUN 2019",
        verbatim: "kalimat yang tidak ada dalam dokumen sumber ini sama sekali",
      })],
      room("Akta Pendirian Nomor 16 tanggal 15 April 2009.")
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("AHU-99999.AH.01.02.TAHUN 2019");
    expect(out[0].text).toContain("Notaris Fiktif");
    expect(out[0].text).toContain("Kutipan yang mendasari");
  });
});
