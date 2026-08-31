/**
 * Does the article a report cites actually exist, and does it contain the paragraph
 * and letter the report names?
 *
 * Built after reading a live report. In two adjacent sentences it said:
 *
 *   "Pasal 142 ayat (1) mewajibkan pembubaran ... atau penetapan Menteri"
 *      — Pasal 142(1) lists six grounds and "penetapan Menteri" is not among them.
 *   "Pasal 142 ayat (2) mewajibkan RUPS ... sekaligus menunjuk likuidator"
 *      — that is Pasal 142(3), and it says the opposite: where the GMS does NOT
 *        appoint one, the Board acts as liquidator.
 *   "Pasal 142 ayat (2) huruf c mensyaratkan pembubaran hanya dapat dilakukan
 *    apabila harta cukup untuk membayar seluruh kewajiban"
 *      — ayat (2) has only huruf a and b. The rule is Pasal 149 ayat (2), and it
 *        carries an exception the sentence dropped: the liquidator must file for
 *        bankruptcy UNLESS every known creditor agrees to settle outside it. For a
 *        company whose debt is almost entirely to related parties, that exception is
 *        the whole question.
 *
 * The same paragraph also cited Pasal 142(2) correctly. So this is not a model that
 * does not know the statute; it is one that mixes sound citations with invented ones
 * in the same confident sentence — and nothing in the pipeline looked. The quote
 * check verifies text against DOCUMENTS. The currency check confirms a regulation is
 * in force, which UUPT is. Neither reads the article.
 *
 * This does the part that can be done mechanically and completely: existence. A
 * citation to an article, paragraph or letter that is not there is wrong whatever it
 * claims, and that alone would have caught two of the three above. Whether an
 * existing article says what the sentence claims is a question of meaning, and is
 * left to the lawyer — but the report now says which citations were checked.
 */

import { UUPT_STRUCTURE } from "@/config/uuptStructure";
import {
  MANPOWER_AMENDED, MANPOWER_INSERTED, MANPOWER_REPEALED, MANPOWER_STRUCTURE,
} from "@/config/manpowerStructure";

export type DDCitationVerdict =
  | "exists"
  | "article_missing"
  | "article_repealed"
  | "ayat_missing"
  | "huruf_missing"
  | "unknown_statute";

export interface DDCitationCheck {
  /** As written in the report, e.g. "UUPT Pasal 142 ayat (2) huruf c". */
  ref: string;
  verdict: DDCitationVerdict;
  note: string;
}

/**
 * Articles keyed by number.
 *
 * The statute text prints each article heading twice — once in a running head, once
 * over the provision — so the longer of the two is the real body. Headings sit alone
 * on their line, which is what makes this reliable; matching "Pasal N" anywhere in
 * the text would split every article at its own cross-references, which is exactly
 * the mistake a first attempt made.
 */
export function parseStatute(text: string): Map<string, string> {
  // Only the enacting text. An Indonesian statute is published together with its
  // PENJELASAN, the official elucidation, which repeats every article heading — and
  // for some articles the elucidation is the longer of the two, so "keep the longer
  // body" silently returned the commentary instead of the provision. Checking a
  // citation against the elucidation is checking it against the wrong text.
  const cut = text.search(/^\s*P\s?E\s?N\s?J\s?E\s?L\s?A\s?S\s?A\s?N\s*$/m);
  const enacting = cut === -1 ? text : text.slice(0, cut);
  const lines = enacting.split(/\r?\n/);
  const heads: { no: string; at: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*Pasal\s+(\d+[A-Z]?)\s*$/.exec(lines[i]);
    if (m) heads.push({ no: m[1], at: i });
  }
  const out = new Map<string, string>();
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].at : lines.length;
    const body = lines.slice(heads[i].at + 1, end).join(" ").replace(/\s+/g, " ").trim();
    const prev = out.get(heads[i].no);
    if (prev === undefined || body.length > prev.length) out.set(heads[i].no, body);
  }
  return out;
}

/**
 * The text of one numbered paragraph, or null when the article has no such ayat.
 *
 * Accepts "1)" as well as "(1)". The statute text is a scrape, and in at least one
 * article — Pasal 152 — the opening bracket of the first paragraph is missing. A
 * checker that insisted on "(1)" read that article as having no paragraphs at all
 * and then accused two correct citations of naming paragraphs that do not exist.
 * That reached a live run. A false accusation about a lawyer's citation is worse
 * than no check, so this tolerates the defect rather than reporting it as the
 * lawyer's.
 */
export function ayatText(articleBody: string, n: number): string | null {
  const find = (k: number): number => {
    const bracketed = articleBody.indexOf(`(${k})`);
    if (bracketed !== -1) return bracketed;
    // Only at a boundary, so "Pasal 152" cannot match "2)" inside a number.
    const m = new RegExp(`(^|[^0-9(])${k}\\)`).exec(articleBody);
    return m === null ? -1 : m.index + m[1].length;
  };
  const start = find(n);
  if (start === -1) return null;
  const next = find(n + 1);
  return articleBody.slice(start, next === -1 || next <= start ? articleBody.length : next);
}

/** Letters are written "a." at the start of each item. */
export function hasHuruf(scope: string, letter: string): boolean {
  return new RegExp(`(^|[\\s;])${letter}\\.`).test(scope);
}

const CITE =
  /Pasal\s+(\d+[A-Z]?)(?:\s+ayat\s+\((\d+)\))?(?:\s+huruf\s+([a-z]))?/g;

/**
 * Citations in a piece of report text, checked against one statute.
 *
 * Only citations this statute governs are judged. A sentence naming another statute
 * — the Civil Code, the manpower law, a notary law, or the company's own articles of
 * association, which are also written "Pasal 3" — is skipped rather than guessed at,
 * because a false accusation about a lawyer's citation is worse than no check.
 */
export function checkCitations(
  text: string,
  articles: Map<string, string>,
  opts: {
    statuteHints?: RegExp;
    foreignHints?: RegExp;
    /** Articles a later statute deleted. Citing one cites a provision that is gone. */
    repealed?: ReadonlySet<string>;
    /**
     * Articles a later statute rewrote. They still exist, so the citation is not
     * wrong — but the paragraph structure on record is the superseded one, and
     * judging "ayat (4)" against text that no longer governs would manufacture
     * exactly the false accusation this checker exists to avoid. Article existence
     * is checked; ayat and huruf are not.
     */
    amended?: ReadonlySet<string>;
    /** Named in the note, so the reader knows which statute repealed the article. */
    amendedBy?: string;
  } = {}
): DDCitationCheck[] {
  const own = opts.statuteHints ?? /UUPT|UU\s*(No\.?\s*)?40[\s/]*(Tahun\s*)?2007|Undang-Undang Perseroan Terbatas/i;
  const foreign =
    opts.foreignHints ??
    /Anggaran Dasar|KUHPerdata|Kitab Undang-Undang|Ketenagakerjaan|UU\s*(No\.?\s*)?(13|30|2|8|19|37|11|6|42|4|28|7|5|3)[\s/]|Cipta Kerja|\bPP\b|POJK|KUP|BPJS|Minerba|Kepailitan/i;

  const out: DDCitationCheck[] = [];
  const seen = new Set<string>();
  for (const sentence of text.split(/(?<=[.;:])\s+|\n/)) {
    if (!/Pasal\s+\d/.test(sentence)) continue;
    // A sentence that names another instrument and does not name this one is not
    // ours to judge.
    if (foreign.test(sentence) && !own.test(sentence)) continue;
    if (!own.test(sentence)) continue;

    CITE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITE.exec(sentence)) !== null) {
      const [, no, ayat, huruf] = m;
      const ref = `Pasal ${no}${ayat ? ` ayat (${ayat})` : ""}${huruf ? ` huruf ${huruf}` : ""}`;
      if (seen.has(ref)) continue;
      seen.add(ref);

      const body = articles.get(no);
      if (body === undefined) {
        out.push({ ref, verdict: "article_missing", note: `${ref} tidak terdapat dalam undang-undang yang dirujuk.` });
        continue;
      }
      if (opts.repealed?.has(no)) {
        const by = opts.amendedBy ? ` oleh ${opts.amendedBy}` : "";
        out.push({
          ref,
          verdict: "article_repealed",
          note: `Pasal ${no} telah DIHAPUS${by} dan tidak lagi berlaku. Rujukan ini perlu diganti dengan ketentuan yang menggantikannya.`,
        });
        continue;
      }
      // Exists, but the structure on record is superseded — go no deeper.
      if (opts.amended?.has(no)) {
        out.push({ ref, verdict: "exists", note: "" });
        continue;
      }
      let scope = body;
      if (ayat) {
        const a = ayatText(body, Number(ayat));
        if (a === null) {
          out.push({ ref, verdict: "ayat_missing", note: `Pasal ${no} tidak memiliki ayat (${ayat}).` });
          continue;
        }
        scope = a;
      }
      if (huruf && !hasHuruf(scope, huruf)) {
        out.push({
          ref,
          verdict: "huruf_missing",
          note: `Pasal ${no}${ayat ? ` ayat (${ayat})` : ""} tidak memiliki huruf ${huruf}.`,
        });
        continue;
      }
      out.push({ ref, verdict: "exists", note: "" });
    }
  }
  return out;
}

/** Citations that do not exist as written. */
export function badCitations(checks: DDCitationCheck[]): DDCitationCheck[] {
  return checks.filter((c) => c.verdict !== "exists");
}


/** Rebuild just enough shape for the same code path: each ayat as "(n) a. b. ...". */
function articlesFrom(structure: Record<string, Record<string, string>>): Map<string, string> {
  const articles = new Map<string, string>();
  for (const [no, ayats] of Object.entries(structure)) {
    const parts: string[] = [];
    const keys = Object.keys(ayats).sort((a, b) => Number(a) - Number(b));
    for (const k of keys) {
      const letters = ayats[k]
        .split("")
        .map((L) => `${L}. `)
        .join("");
      parts.push(k === "0" ? letters : `(${k}) ${letters}`);
    }
    articles.set(no, parts.join(" "));
  }
  return articles;
}

/**
 * The same check against UUPT, using the committed structure map.
 *
 * This is what runs in production. parseStatute() above stays for regenerating that
 * map and for the tests that assert it against the statute text itself, so the map
 * can never drift from the law without a test noticing.
 */
export function checkUUPTCitations(text: string): DDCitationCheck[] {
  return checkCitations(text, articlesFrom(UUPT_STRUCTURE));
}

const MANPOWER_HINTS =
  /UU\s*(No\.?\s*)?13[\s/]*(Tahun\s*)?2003|Undang-Undang Ketenagakerjaan|\bUUK\b|Ketenagakerjaan/i;
const MANPOWER_FOREIGN =
  /UUPT|UU\s*(No\.?\s*)?(40[\s/]*(Tahun\s*)?2007|30|2|8|19|37|11|42|4|28|7|5|3)[\s/]|Anggaran Dasar|KUHPerdata|Kitab Undang-Undang|Perseroan Terbatas|POJK|KUP|Minerba|Kepailitan|\bPP\b|Permenaker|Peraturan Menteri/i;

/**
 * The same check against the manpower law, which needs one thing UUPT did not.
 *
 * UUPT is in force as enacted. UU 13/2003 is not: Cipta Kerja deleted 28 of its
 * articles and rewrote 34 more, so "the article exists in the 2003 text" is not the
 * same question as "the article exists". A live report cited Pasal 91 for a
 * severance-waiver clause — wrong article (severance is Pasal 156) and a deleted one.
 * Checking against the 2003 text alone would have confirmed it.
 */
export function checkManpowerCitations(text: string): DDCitationCheck[] {
  // Inserted articles join the amended ones: both exist, and for both the paragraph
  // structure on record is either superseded or absent, so neither is judged below
  // article level.
  const unstructured = new Set(Array.from(MANPOWER_AMENDED).concat(Array.from(MANPOWER_INSERTED)));
  return checkCitations(text, articlesFrom(MANPOWER_STRUCTURE), {
    statuteHints: MANPOWER_HINTS,
    foreignHints: MANPOWER_FOREIGN,
    repealed: MANPOWER_REPEALED,
    amended: unstructured,
    amendedBy: "UU 6/2023 (Cipta Kerja)",
  });
}

/** Every statute this pipeline can check a citation against. */
export function checkAllCitations(text: string): DDCitationCheck[] {
  return [...checkUUPTCitations(text), ...checkManpowerCitations(text)];
}
