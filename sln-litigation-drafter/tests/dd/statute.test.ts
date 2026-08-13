import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ayatText, badCitations, checkCitations, checkUUPTCitations, hasHuruf, parseStatute,
} from "@/lib/dd/statute";
import { UUPT_STRUCTURE } from "@/config/uuptStructure";

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
