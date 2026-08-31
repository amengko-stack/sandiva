import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ayatText, badCitations, checkAllCitations, checkManpowerCitations,
  checkUUPTCitations, hasHuruf, parseStatute,
} from "@/lib/dd/statute";
import {
  MANPOWER_AMENDED, MANPOWER_INSERTED, MANPOWER_REPEALED, MANPOWER_STRUCTURE,
} from "@/config/manpowerStructure";

// Why the manpower law needs something UUPT did not.
//
// UUPT is in force as enacted, so "the article is in the text" answers "the article
// exists". UU 13/2003 is not: Cipta Kerja deleted 28 of its articles, rewrote 34, and
// inserted 14 that the 2003 text has never contained. Both directions are traps. A
// check against the 2003 text alone would confirm Pasal 91 — deleted in 2023 — and
// would call Pasal 61A missing, which it is not.
//
// Pasal 91 is the worked example throughout because it is the shape of error that
// survives every other check: a real article number, in force when the precedent
// memos on the shelf were written, saying something plausible about wages. It reads
// like a citation to severance and is neither severance (that is Pasal 156) nor in
// force.

const body = readFileSync(join(process.cwd(), "data/statutes/uu13-2003.txt"), "utf8");
const articles = parseStatute(body);

describe("the committed manpower map against the statute text", () => {
  // The same guarantee the UUPT map has: the map cannot drift from the law without a
  // test noticing, because the checker's own parser re-derives it here.
  it("carries every article in the enacting text, plus the ones Cipta Kerja added", () => {
    const expected = Array.from(articles.keys()).concat(Array.from(MANPOWER_INSERTED)).sort();
    expect(Object.keys(MANPOWER_STRUCTURE).sort()).toEqual(expected);
  });

  it("runs 1 through 193 with no gaps", () => {
    const nums = Object.keys(MANPOWER_STRUCTURE)
      .filter((k) => /^[0-9]+$/.test(k))
      .map(Number)
      .sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(193);
    expect(nums).toHaveLength(193);
  });

  it("records each ayat's lettered items as the statute has them", () => {
    for (const [no, ayats] of Object.entries(MANPOWER_STRUCTURE)) {
      if (MANPOWER_INSERTED.has(no)) continue; // no 2003 text to check it against
      const text = articles.get(no)!;
      for (const [k, letters] of Object.entries(ayats)) {
        const scope = k === "0" ? text : ayatText(text, Number(k))!;
        expect(scope, `Pasal ${no} ayat (${k})`).not.toBeNull();
        for (const L of letters) expect(hasHuruf(scope, L), `Pasal ${no} (${k}) huruf ${L}`).toBe(true);
      }
    }
  });

  // Both lists come from a scan of UU 6/2023. Every article they name must be a real
  // article of the 2003 law; one that is not would mean a misparse in either source.
  it("repeals and amends only articles the 2003 law actually has", () => {
    for (const a of Array.from(MANPOWER_REPEALED).concat(Array.from(MANPOWER_AMENDED))) {
      expect(articles.has(a), `Pasal ${a}`).toBe(true);
    }
  });

  it("never puts one article in two categories", () => {
    const rep = Array.from(MANPOWER_REPEALED);
    const amd = Array.from(MANPOWER_AMENDED);
    expect(rep.filter((a) => MANPOWER_AMENDED.has(a))).toEqual([]);
    expect(rep.filter((a) => MANPOWER_INSERTED.has(a))).toEqual([]);
    expect(amd.filter((a) => MANPOWER_INSERTED.has(a))).toEqual([]);
  });

  // An inserted article is absent from the 2003 text by definition, so it must never
  // be looked for there — and its own text exists only in a scan too noisy to build a
  // paragraph map from.
  it("records the inserted articles with no paragraph structure", () => {
    expect(MANPOWER_INSERTED.size).toBe(14);
    for (const a of Array.from(MANPOWER_INSERTED)) {
      expect(articles.has(a), `Pasal ${a} should not be in the 2003 text`).toBe(false);
      expect(MANPOWER_STRUCTURE[a], `Pasal ${a}`).toEqual({});
    }
  });

  // 28 + 34 + 8 inserted + 1 heading = 71, the highest item number in UU 6/2023
  // Pasal 81. The counts are asserted so a regenerated map cannot quietly lose items.
  it("keeps the counts the parse closed on", () => {
    expect(MANPOWER_REPEALED.size).toBe(28);
    expect(MANPOWER_AMENDED.size).toBe(34);
  });
});

describe("the citation that started this", () => {
  const cite = (t: string) => checkManpowerCitations(t);

  it("reports Pasal 91 as deleted rather than confirming it", () => {
    const [c] = cite("Klausul tersebut bertentangan dengan Pasal 91 UU 13/2003 tentang Ketenagakerjaan.");
    expect(c.verdict).toBe("article_repealed");
    expect(c.note).toContain("DIHAPUS");
    expect(c.note).toContain("UU 6/2023");
  });

  it("accepts Pasal 156, which is the provision that governs severance", () => {
    const [c] = cite("Uang pesangon diatur dalam Pasal 156 UU 13/2003 tentang Ketenagakerjaan.");
    expect(c.verdict).toBe("exists");
  });

  // Found by running the finished checker over a real report, which is the only place
  // it could have been found: Pasal 61A came back "missing". It is a real provision —
  // Cipta Kerja inserted it between 61 and 62 — and a map built from the 2003 text
  // alone cannot know that. A false accusation about a lawyer's citation is worse than
  // no check at all.
  it("accepts an article Cipta Kerja inserted, which the 2003 text never had", () => {
    const [c] = cite("PKWT tunduk pada Pasal 61A UU 13/2003 tentang Ketenagakerjaan.");
    expect(c.verdict).toBe("exists");
  });

  it("catches an article the statute does not have at all", () => {
    const [c] = cite("Lihat Pasal 250 UU 13/2003 tentang Ketenagakerjaan.");
    expect(c.verdict).toBe("article_missing");
  });
});

describe("what the checker refuses to judge", () => {
  // Cipta Kerja replaced the paragraph structure of the articles it rewrote. Judging
  // "ayat (4)" against the 2003 text would invent a defect the lawyer would have to
  // disprove — the failure this checker exists to avoid.
  it("checks an amended article's existence but not its paragraphs", () => {
    expect(MANPOWER_AMENDED.has("156")).toBe(true);
    const [c] = checkManpowerCitations("Lihat Pasal 156 ayat (9) huruf z UU 13/2003 tentang Ketenagakerjaan.");
    expect(c.verdict).toBe("exists");
  });

  it("still checks paragraphs on an article Cipta Kerja left alone", () => {
    expect(MANPOWER_REPEALED.has("108")).toBe(false);
    expect(MANPOWER_AMENDED.has("108")).toBe(false);
    const [c] = checkManpowerCitations("Lihat Pasal 108 ayat (9) UU 13/2003 tentang Ketenagakerjaan.");
    expect(c.verdict).toBe("ayat_missing");
  });

  it("leaves a sentence about another statute alone", () => {
    expect(checkManpowerCitations("Pasal 142 ayat (1) UUPT mengatur pembubaran.")).toEqual([]);
    expect(checkUUPTCitations("Pasal 156 UU 13/2003 tentang Ketenagakerjaan mengatur pesangon.")).toEqual([]);
  });
});

describe("checkAllCitations", () => {
  it("judges each sentence against the statute it names", () => {
    const bad = badCitations(
      checkAllCitations(
        "Pembubaran tunduk pada Pasal 142 ayat (2) huruf c UUPT. " +
          "Pesangon dikesampingkan berdasarkan Pasal 91 UU 13/2003 tentang Ketenagakerjaan."
      )
    );
    expect(bad.map((b) => b.verdict).sort()).toEqual(["article_repealed", "huruf_missing"]);
  });

  it("is silent on a report whose citations are all sound", () => {
    expect(
      badCitations(
        checkAllCitations(
          "Likuidasi tunduk pada Pasal 142 ayat (1) UUPT. " +
            "Pesangon dihitung menurut Pasal 156 UU 13/2003 tentang Ketenagakerjaan."
        )
      )
    ).toEqual([]);
  });
});
