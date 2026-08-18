import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ayatText, badCitations, checkCitations, checkUUPTCitations, hasHuruf, parseStatute,
} from "@/lib/dd/statute";
import { UUPT_STRUCTURE } from "@/config/uuptStructure";
import { redflagSystem } from "@/lib/dd/prompts";

// Built after reading a live report that made three claims about UUPT Pasal 142 in
// two adjacent sentences, and got all three wrong — including a citation to a huruf
// that does not exist. The same paragraph cited the same article correctly
// elsewhere, so the failure is not ignorance of the statute but confident invention
// mixed into sound work, which nothing in the pipeline was looking at.

const articles = parseStatute(
  readFileSync(join(process.cwd(), "data/statutes/uu40-2007.txt"), "utf8")
);

describe("parseStatute", () => {
  it("finds every article of UUPT", () => {
    expect(articles.size).toBeGreaterThanOrEqual(161);
    expect(articles.has("1")).toBe(true);
    expect(articles.has("161")).toBe(true);
  });

  // The first attempt matched "Pasal N" anywhere and split every article at its own
  // cross-references, so bodies were fragments and every check on them was noise.
  it("does not split an article at a cross-reference inside its own text", () => {
    const p33 = articles.get("33") ?? "";
    expect(p33).toContain("Pasal 32");
    expect(p33).toContain("25%");
    expect(p33).toContain("ditempatkan dan disetor penuh");
  });

  it("keeps the provision, not the running head", () => {
    const p142 = articles.get("142") ?? "";
    expect(p142).toContain("berdasarkan keputusan RUPS");
    expect(p142.length).toBeGreaterThan(400);
  });
});

describe("ayat and huruf", () => {
  const p142 = articles.get("142") ?? "";

  it("reads a numbered paragraph", () => {
    expect(ayatText(p142, 1)).toContain("Pembubaran Perseroan terjadi");
    expect(ayatText(p142, 2)).toContain("wajib diikuti dengan likuidasi");
  });

  it("returns null for a paragraph the article does not have", () => {
    expect(ayatText(articles.get("3") ?? "", 9)).toBeNull();
  });

  // The heart of it: Pasal 142 ayat (2) has a and b, and nothing else.
  it("knows Pasal 142 ayat (2) has no huruf c", () => {
    const a2 = ayatText(p142, 2) ?? "";
    expect(hasHuruf(a2, "a")).toBe(true);
    expect(hasHuruf(a2, "b")).toBe(true);
    expect(hasHuruf(a2, "c")).toBe(false);
  });

  it("knows Pasal 142 ayat (1) does have huruf c", () => {
    expect(hasHuruf(ayatText(p142, 1) ?? "", "c")).toBe(true);
  });
});

describe("checkCitations", () => {
  const check = (text: string) => checkCitations(text, articles);

  // The citation that prompted all of this.
  it("catches the invented huruf from the live report", () => {
    const bad = badCitations(
      check(
        "UUPT Pasal 142 ayat (2) huruf c mensyaratkan bahwa pembubaran dan likuidasi hanya dapat dilakukan apabila harta kekayaan Perseroan cukup."
      )
    );
    expect(bad).toHaveLength(1);
    expect(bad[0].verdict).toBe("huruf_missing");
    expect(bad[0].note).toContain("tidak memiliki huruf c");
  });

  it("passes citations that are real", () => {
    const out = check(
      "Berdasarkan UUPT Pasal 142 ayat (1) huruf a, pembubaran terjadi berdasarkan keputusan RUPS, dan UUPT Pasal 149 ayat (2) mengatur kewajiban likuidator."
    );
    expect(badCitations(out)).toEqual([]);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("catches an article that does not exist in the statute", () => {
    const bad = badCitations(check("Menurut UUPT Pasal 400, Perseroan wajib membubarkan diri."));
    expect(bad[0].verdict).toBe("article_missing");
  });

  it("catches a paragraph the article does not have", () => {
    const bad = badCitations(check("UUPT Pasal 142 ayat (9) mengatur hal tersebut."));
    expect(bad[0].verdict).toBe("ayat_missing");
  });

  // A false accusation about a lawyer's citation is worse than no check, so anything
  // governed by another instrument is left alone.
  it("does not judge the company's own articles of association", () => {
    expect(check("Perubahan Pasal 3 Anggaran Dasar mengenai Maksud dan Tujuan.")).toEqual([]);
    expect(check("penambahan Pasal 17 ayat (10) Anggaran Dasar mengenai kewenangan Direksi.")).toEqual([]);
  });

  it("does not judge citations to other statutes", () => {
    expect(check("berdasarkan Pasal 1338 Kitab Undang-Undang Hukum Perdata")).toEqual([]);
    expect(check("Uang pesangon menurut UU 13/2003 Pasal 156 ayat (2).")).toEqual([]);
    expect(check("sesuai UU 30/2004 Pasal 39 ayat (1) mengenai kewajiban notaris")).toEqual([]);
  });

  it("judges a sentence that names UUPT even when another instrument appears too", () => {
    const bad = badCitations(
      check("UUPT Pasal 142 ayat (2) huruf c jo. PP 45/2005 mengatur pembubaran BUMN.")
    );
    expect(bad).toHaveLength(1);
    expect(bad[0].verdict).toBe("huruf_missing");
  });

  it("reports each distinct citation once", () => {
    const out = check(
      "UUPT Pasal 142 ayat (1) menyebutkan enam sebab. UUPT Pasal 142 ayat (1) juga berlaku bagi BUMN."
    );
    expect(out.filter((c) => c.ref === "Pasal 142 ayat (1)")).toHaveLength(1);
  });
});

// The production path uses the committed structure map rather than the 321 KB
// statute file, which a serverless bundle cannot be relied on to carry. These assert
// the map against the statute text, so it cannot drift from the law unnoticed.
describe("checkUUPTCitations, the path that runs in production", () => {
  it("agrees with the statute text on the citation that started this", () => {
    const bad = badCitations(
      checkUUPTCitations("UUPT Pasal 142 ayat (2) huruf c mensyaratkan harta cukup untuk membayar kewajiban.")
    );
    expect(bad).toHaveLength(1);
    expect(bad[0].verdict).toBe("huruf_missing");
  });

  it("accepts the citations the report got right", () => {
    expect(
      badCitations(checkUUPTCitations("UUPT Pasal 142 ayat (1) huruf a dan UUPT Pasal 149 ayat (2)."))
    ).toEqual([]);
  });

  it("carries every article of the statute", () => {
    const fromText = parseStatute(
      readFileSync(join(process.cwd(), "data/statutes/uu40-2007.txt"), "utf8")
    );
    for (const no of Array.from(fromText.keys())) {
      expect(UUPT_STRUCTURE[no], `Pasal ${no}`).toBeDefined();
    }
  });

  it("matches the statute text on which paragraphs have lettered items", () => {
    const fromText = parseStatute(
      readFileSync(join(process.cwd(), "data/statutes/uu40-2007.txt"), "utf8")
    );
    for (const [no, ayats] of Object.entries(UUPT_STRUCTURE)) {
      const body = fromText.get(no);
      if (body === undefined) continue;
      for (const [n, letters] of Object.entries(ayats)) {
        if (n === "0") continue;
        const scope = ayatText(body, Number(n));
        if (scope === null) continue;
        for (const L of letters) expect(hasHuruf(scope, L), `Pasal ${no} (${n}) ${L}`).toBe(true);
      }
    }
  });
});

// Five substantive misstatements of UUPT were found by reading one live report, and
// the citation check above catches exactly one of them: the others cite articles
// that exist and simply say something else. There is no mechanical test for that, so
// the provisions themselves are stated in the prompt — verified here against the
// statute text so the prompt cannot drift from the law it is quoting.
describe("the provisions the model misquoted, stated in the prompt", () => {
  const p = redflagSystem();
  const body = readFileSync(join(process.cwd(), "data/statutes/uu40-2007.txt"), "utf8");
  const enacting = body.slice(0, body.search(/^\s*P\s?E\s?N\s?J\s?E\s?L\s?A\s?S\s?A\s?N\s*$/m));

  it("tells the model Pasal 142 ayat (1) has six grounds and no ministerial decree", () => {
    expect(p).toContain("ENAM sebab pembubaran");
    expect(p).toContain('TIDAK ada "penetapan Menteri"');
    // And the statute agrees: six lettered grounds, a through f.
    const a1 = ayatText(articles.get("142") ?? "", 1) ?? "";
    for (const L of "abcdef") expect(hasHuruf(a1, L), L).toBe(true);
    expect(hasHuruf(a1, "g")).toBe(false);
  });

  it("tells it Pasal 142 ayat (2) has no huruf c", () => {
    expect(p).toContain("hanya memiliki huruf a dan b");
  });

  // The exception is the point: the report dropped it, and for a company whose debt
  // is almost all to related parties it decides whether liquidation is available.
  it("requires the creditor-consent exception in Pasal 149 ayat (2) to be stated", () => {
    expect(p).toContain("Pasal 149 ayat (2)");
    expect(p).toContain("menyetujui pemberesan di luar kepailitan");
    expect(ayatText(articles.get("149") ?? "", 2) ?? "").toContain("di luar kepailitan");
  });

  it("corrects the invented registered-letter obligation in Pasal 147 ayat (1)", () => {
    expect(p).toContain('TIDAK ada kewajiban "surat tercatat"');
    const a1 = ayatText(articles.get("147") ?? "", 1) ?? "";
    expect(a1).toContain("Surat Kabar");
    expect(a1).toContain("Berita Negara");
    expect(a1).not.toContain("surat tercatat");
  });

  // UUPT ranks nobody. A heading that presumes a ranking will be given one.
  it("says UUPT contains no payment ranking, which the statute bears out", () => {
    expect(p).toContain("TIDAK memuat urutan prioritas pembayaran");
    for (const w of ["urutan", "prioritas", "didahulukan", "preferen", "istimewa"]) {
      expect(enacting.toLowerCase().includes(w), w).toBe(false);
    }
  });

  it("puts the distribution-plan objection in Pasal 149, not Pasal 151", () => {
    expect(p).toContain("Pasal 149 ayat (3) dan (4), bukan Pasal 151");
    expect(ayatText(articles.get("149") ?? "", 3) ?? "").toContain("keberatan atas rencana pembagian");
    expect(articles.get("151") ?? "").toContain("mengangkat likuidator baru");
  });

  it("states the general rule: where the statute is silent, say so", () => {
    expect(p).toContain("NYATAKAN bahwa undang-undang tidak mengaturnya");
  });
});

// Found by reading BAB IV of the same report: "Pasal 56 ayat (1) mewajibkan
// pemindahan hak atas saham dicatat dalam DPS dan DPS ditandatangani oleh anggota
// Direksi". Wrong twice over, and both halves verified against the statute below.
describe("Pasal 56, misquoted in the capital chapter", () => {
  const p = redflagSystem();

  it("states what 56 ayat (1) actually requires: a transfer deed", () => {
    expect(p).toContain("AKTA PEMINDAHAN HAK");
    expect(ayatText(articles.get("56") ?? "", 1) ?? "").toContain("akta pemindahan hak");
  });

  it("puts the recording duty in ayat (3), where it is", () => {
    expect(p).toContain("Pasal 56 ayat (3), bukan ayat (1)");
    const a3 = ayatText(articles.get("56") ?? "", 3) ?? "";
    expect(a3).toContain("wajib mencatat");
    expect(a3).toContain("30");
  });

  // The signing requirement was invented outright: the word appears seven times in
  // the enacting text, about deeds, ministerial decisions and GMS minutes — never
  // about the shareholder register.
  it("says UUPT does not require the register to be signed, which it does not", () => {
    expect(p).toContain("TIDAK mewajibkan daftar pemegang saham ditandatangani");
    const enacting = readFileSync(join(process.cwd(), "data/statutes/uu40-2007.txt"), "utf8");
    const cut = enacting.search(/^\s*P\s?E\s?N\s?J\s?E\s?L\s?A\s?S\s?A\s?N\s*$/m);
    const text = (cut === -1 ? enacting : enacting.slice(0, cut)).replace(/\s+/g, " ");
    for (const m of Array.from(text.matchAll(/.{60}ditandatangani/gi))) {
      expect(m[0].toLowerCase()).not.toContain("daftar pemegang saham");
    }
  });
});

// The statute text is a scrape, and in six articles the opening bracket of a
// paragraph is missing — "1)" instead of "(1)". A parser that insisted on the
// bracketed form read those articles as having no paragraphs and then accused
// correct citations of naming paragraphs that do not exist. Two such accusations
// reached a live run, against Pasal 152 ayat (1) and ayat (3), both of which are
// real. A false accusation about a lawyer's citation is worse than no check.
describe("articles whose paragraph markers the source text mangled", () => {
  it("reads Pasal 152, where the first paragraph opens as \"1)\"", () => {
    const p152 = articles.get("152") ?? "";
    expect(ayatText(p152, 1)).toContain("Likuidator bertanggung jawab kepada RUPS");
    expect(ayatText(p152, 3)).toContain("mengumumkan hasil akhir proses likuidasi");
    expect(UUPT_STRUCTURE["152"]["1"]).toBeDefined();
    expect(UUPT_STRUCTURE["152"]["3"]).toBeDefined();
  });

  it("no longer accuses the citations that were wrongly flagged live", () => {
    const bad = badCitations(
      checkUUPTCitations(
        "Likuidator wajib bertanggung jawab kepada RUPS menurut UUPT Pasal 152 ayat (1) dan mengumumkan hasil akhir likuidasi menurut UUPT Pasal 152 ayat (3)."
      )
    );
    expect(bad).toEqual([]);
  });

  it("carries the paragraphs of every article the artefact affected", () => {
    for (const no of ["17", "31", "65", "79", "98", "152"]) {
      expect(Object.keys(UUPT_STRUCTURE[no]), `Pasal ${no}`).not.toEqual(["0"]);
    }
  });

  // Tolerating "1)" must not make "Pasal 152" itself look like paragraph 2.
  it("does not read a paragraph number out of an article number", () => {
    expect(ayatText("Ketentuan Pasal 152 berlaku juga.", 2)).toBeNull();
  });
});
