import { describe, it, expect } from "vitest";
import {
  checkCitationLinks, checkQuote, isUngrounded, normaliseForMatch,
  traceCitation,
} from "@/lib/dd/grounding";

// The requirement: what the report says about a document must actually be in that
// document. Nothing enforced it — a model finding's "verbatim quote" was trusted
// as given, so a paraphrase, a mis-attribution, or an invented quote reached the
// client report as fact.

const DOC =
  "Akta Pendirian Nomor 16 tanggal 15 April 2009, dibuat di hadapan Musa Muamarta, S.H., " +
  "Notaris di Jakarta, telah memperoleh pengesahan dari Menteri Hukum dan Hak Asasi Manusia " +
  "berdasarkan Keputusan Nomor AHU-27282.AH.01.01.Tahun 2009. Modal dasar Perseroan sebesar " +
  "Rp 50.000.000 terbagi atas 500 saham.";

describe("checkQuote", () => {
  it("verifies a quote the document actually contains", () => {
    const r = checkQuote("Notaris di Jakarta, telah memperoleh pengesahan", DOC);
    expect(r.verdict).toBe("verified");
    expect(r.coverage).toBe(1);
  });

  // PDF extraction breaks lines mid-sentence and OCR substitutes quote and dash
  // characters, so a genuine quote must survive those differences.
  it("verifies across collapsed whitespace, curly quotes and en dashes", () => {
    const doc = 'Perseroan bernama “PT Alpha” – berkedudukan di Jakarta.';
    expect(checkQuote('Perseroan bernama "PT Alpha" - berkedudukan', doc).verdict).toBe("verified");
    expect(checkQuote("Akta Pendirian   Nomor 16\n  tanggal 15 April 2009", DOC).verdict).toBe("verified");
  });

  it("reports a paraphrase as paraphrased, not as verified", () => {
    // Most of the wording is the document's, but it is not a direct quote.
    const r = checkQuote("Akta Pendirian Nomor 16 tanggal 15 April 2009 dibuat oleh notaris", DOC);
    expect(r.verdict).toBe("paraphrased");
    expect(r.coverage).toBeGreaterThan(0.6);
    expect(r.coverage).toBeLessThan(1);
  });

  it("reports an invented quote as not found", () => {
    const r = checkQuote(
      "Perseroan telah memperoleh Nomor Induk Berusaha dan izin lingkungan yang berlaku",
      DOC
    );
    expect(r.verdict).toBe("not_found");
    expect(isUngrounded(r.verdict)).toBe(true);
  });

  // The check is per-document on purpose. Checking against the whole data room
  // would let a quote from one document vouch for a claim about another, which is
  // the mis-attribution this exists to catch.
  it("reports a quote attributed to a document that was never extracted", () => {
    const r = checkQuote("Notaris di Jakarta", undefined);
    expect(r.verdict).toBe("source_missing");
    expect(isUngrounded(r.verdict)).toBe(true);
  });

  it("reports an empty source document as source_missing rather than passing it", () => {
    expect(checkQuote("Notaris di Jakarta, telah memperoleh", "").verdict).toBe("source_missing");
  });

  it("declines to judge an absent or too-short quote instead of failing it", () => {
    expect(checkQuote("", DOC).verdict).toBe("no_quote");
    expect(checkQuote("Rp 50", DOC).verdict).toBe("no_quote");
    for (const v of ["no_quote", "verified", "paraphrased"] as const) {
      expect(isUngrounded(v), v).toBe(false);
    }
  });

  it("carries a note in Indonesian that names the problem", () => {
    expect(checkQuote("izin lingkungan yang berlaku dan tidak kedaluwarsa", DOC).note)
      .toContain("tidak ditemukan dalam dokumen sumber");
    expect(checkQuote("Notaris di Jakarta, telah memperoleh", undefined).note)
      .toContain("tidak terdapat di antara dokumen yang diekstrak");
  });
});

describe("checkCitationLinks", () => {
  it("finds a reference number despite spacing and punctuation differences", () => {
    const out = checkCitationLinks(
      [{ label: "SK Menkumham", value: "AHU-27282.AH.01.01. Tahun 2009" }],
      DOC
    );
    expect(out[0].found).toBe(true);
  });

  it("flags a reference number the document does not contain", () => {
    const out = checkCitationLinks(
      [{ label: "SK Menkumham", value: "AHU-99999.AH.01.02.TAHUN 2019" }],
      DOC
    );
    expect(out[0].found).toBe(false);
  });

  it("skips empty links rather than reporting them as missing", () => {
    const out = checkCitationLinks(
      [
        { label: "SK Menkumham", value: "AHU-27282.AH.01.01.Tahun 2009" },
        { label: "BNRI", value: "" },
      ],
      DOC
    );
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("SK Menkumham");
  });

  it("treats a missing document as nothing found, never as everything found", () => {
    const out = checkCitationLinks([{ label: "SK", value: "AHU-27282.AH.01.01.Tahun 2009" }], undefined);
    expect(out[0].found).toBe(false);
  });
});

describe("normaliseForMatch", () => {
  it("preserves word order and wording while folding presentation differences", () => {
    expect(normaliseForMatch("  Akta   NOMOR  16 ")).toBe("akta nomor 16");
    expect(normaliseForMatch("“kutipan”")).toBe('"kutipan"');
    // Word order is NOT normalised — a reordered sentence is not the same quote.
    expect(normaliseForMatch("nomor 16 akta")).not.toBe(normaliseForMatch("akta nomor 16"));
  });
});

// A deed's Menkumham decree number is often legitimately read off a LATER
// document — a shareholder register reciting the deed history — rather than off
// the deed itself. A two-way check would report that as fabrication, which would
// be wrong. Hence three outcomes.
describe("traceCitation", () => {
  const DEED = "Akta Nomor 16 tanggal 15 April 2009 dibuat di hadapan Musa Muamarta, S.H.";
  const DPS = "Akta Nomor 16 telah disahkan berdasarkan Keputusan AHU-27282.AH.01.01.Tahun 2009.";

  it("traces a number to its own document", () => {
    expect(traceCitation("Akta Nomor 16", DEED, [DEED, DPS])).toBe("own");
  });

  it("traces a number found only elsewhere to the other document, not to fabrication", () => {
    expect(traceCitation("AHU-27282.AH.01.01.Tahun 2009", DEED, [DEED, DPS])).toBe("other");
  });

  it("reports a number found nowhere as absent", () => {
    expect(traceCitation("AHU-99999.AH.01.02.TAHUN 2019", DEED, [DEED, DPS])).toBe("absent");
  });

  it("matches despite the spacing and punctuation extraction inserts", () => {
    expect(traceCitation("AHU 27282 . AH.01.01 Tahun 2009", undefined, [DPS])).toBe("other");
  });

  // Short strings collide by accident, which would make the check worse than none.
  it("refuses to judge a reference too short to be specific", () => {
    expect(traceCitation("16", DEED, [DEED])).toBe("absent");
    expect(traceCitation("", DEED, [DEED])).toBe("absent");
  });

  it("handles an absent own-document without crediting the corpus for it", () => {
    expect(traceCitation("Musa Muamarta", undefined, [DEED])).toBe("other");
    expect(traceCitation("Musa Muamarta", undefined, [])).toBe("absent");
  });
});
