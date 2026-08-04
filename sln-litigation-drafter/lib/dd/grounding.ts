/**
 * Checks that what the report says about a document is actually in that document.
 *
 * The requirement, in the user's words: "apa yang disajikan dalam laporan bila
 * merujuk dokumen adalah sesuai dengan isi dokumen dan tidak mengarang."
 *
 * Until now nothing enforced it. Every model finding carries an `anchor` that is
 * supposed to be a verbatim quote from `sourceFile`, and the app simply trusted
 * it — a quote could be paraphrased, attributed to the wrong file, or invented
 * outright and still reach the client report as fact.
 *
 * These checks are deterministic and cost nothing: the extracted document text is
 * already in memory when findings are parsed, so a quote can be looked for
 * directly. This follows the pattern that has held twice in this codebase — a
 * prompt instruction is droppable, a post-parse check is not.
 *
 * Deliberately NOT fuzzy-matching into a pass. A near-miss is reported as
 * "paraphrased", not as verified: the point is to know whether the words are the
 * document's own, and a generous matcher would defeat that.
 */

// "verified"       the quote appears in the named source document
// "paraphrased"    enough of it appears to show it came from there, but not verbatim
// "not_found"      the named document exists and does not contain the quote
// "source_missing" the finding names a document that was never extracted
// "no_quote"       nothing to check
import { DD_ANCHOR_EXAMPLES } from "@/lib/dd/prompts";
import type { DDGroundingVerdict } from "@/types/dd";
export type { DDGroundingVerdict };

export interface DDGroundingResult {
  verdict: DDGroundingVerdict;
  /** Longest run of the quote found verbatim in the document, as a fraction 0..1. */
  coverage: number;
  note: string;
}

/**
 * Normalise for comparison without making the match generous: collapse
 * whitespace (PDF extraction breaks lines mid-sentence), unify the quote and
 * dash characters Word and OCR substitute, and fold case. Word ORDER and the
 * words themselves are left alone.
 */
export function normaliseForMatch(s: string): string {
  return s
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Longest common substring length between two strings, in characters. */
function longestCommonRun(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Rolling single-row DP: the quotes are short, the documents are not, so keep
  // memory proportional to the quote rather than to the document.
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** A quote shorter than this cannot be meaningfully verified either way. */
const MIN_QUOTE_CHARS = 12;

/**
 * Split a composite quote into the passages it stitches together.
 *
 * A live run showed 23 of 31 quotes reported "not_found" by a whole-string match,
 * and the cause was not fabrication: the model quotes several separated passages
 * joined by ellipses —
 *   "PT. CIPTA NUGRAH INDONESIA ... Akta Nomor 16, tanggal 15 April 2009 ... AHU-2728"
 * Each passage is genuinely in the document; only the concatenation is not, so a
 * whole-string check condemns a legitimate quoting style. Coverage of 26-38% was
 * the giveaway: the longest verbatim run was exactly one passage.
 */
function splitComposite(quote: string): string[] {
  return quote
    .split(/\s*(?:\.{3,}|…|\[\s*\.{3}\s*\])\s*/)
    .map((part) => part.trim())
    .filter((part) => normaliseForMatch(part).length >= MIN_QUOTE_CHARS);
}
/** Fraction of the quote that must appear verbatim to count as paraphrased. */
const PARAPHRASE_THRESHOLD = 0.6;

/**
 * Did the model quote the instructions instead of the document?
 *
 * The prompt shows a worked example of a well-formed quote, because the abstract
 * instruction did not work. One run later a finding came back quoting that
 * example almost word for word at 25% coverage — the deed's own wording differs
 * ("berjumlah", not "sebesar"). Any realistic example of a verbatim quote is
 * transplantable, so the example was itself a source of fabrication.
 *
 * Reported with its own note rather than as a plain non-match: "the quote is not
 * in the document" and "the quote came from my instructions" call for different
 * responses, and only the second is provably an invention.
 */
const ECHO_MIN_CHARS = 30;
// Two ways to be an echo, because the observed echo reworded the example
// ("berjumlah" -> "sebesar", "Rp." -> "Rp", bracketed number spelling dropped)
// and those edits break the single longest run down to ~0.69 of the quote.
const ECHO_RUN_RATIO = 0.6;
// A long run identical to an instruction sentence, in a quote the cited document
// does not contain, is conclusive on its own. Safe at 40 because the example uses
// figures (Rp 7.350.000.000 / 73.500 saham) no data room holds, so a real deed's
// capital clause shares only the ~35 characters before the figures.
const ECHO_RUN_CHARS = 40;

export function isPromptExampleQuote(quote: string): boolean {
  const q = normaliseForMatch(quote ?? "");
  if (q.length < ECHO_MIN_CHARS) return false;
  for (let i = 0; i < DD_ANCHOR_EXAMPLES.length; i++) {
    const e = normaliseForMatch(DD_ANCHOR_EXAMPLES[i]);
    if (e.length === 0) continue;
    if (e.indexOf(q) !== -1 || q.indexOf(e) !== -1) return true;
    // A reworded echo still shares a long run with the example.
    const run = longestCommonRun(q, e);
    if (run >= ECHO_RUN_CHARS) return true;
    if (run / Math.min(q.length, e.length) >= ECHO_RUN_RATIO) return true;
  }
  return false;
}

/**
 * Does `quote` come from `docText`?
 *
 * `docText` is the extracted text of the single document the report attributes
 * the quote to — not the whole data room. Checking against the whole corpus
 * would let a quote from one document vouch for a claim about another, which is
 * precisely the mis-attribution this is meant to catch.
 */
export function checkQuote(quote: string, docText: string | undefined): DDGroundingResult {
  const q = normaliseForMatch(quote ?? "");
  if (q.length === 0) {
    return { verdict: "no_quote", coverage: 0, note: "Tidak ada kutipan untuk diperiksa." };
  }
  if (docText === undefined) {
    return {
      verdict: "source_missing",
      coverage: 0,
      note: "Dokumen sumber yang dirujuk tidak terdapat di antara dokumen yang diekstrak.",
    };
  }
  const d = normaliseForMatch(docText);
  if (d.length === 0) {
    return {
      verdict: "source_missing",
      coverage: 0,
      note: "Teks dokumen sumber kosong sehingga kutipan tidak dapat diperiksa.",
    };
  }
  if (q.length < MIN_QUOTE_CHARS) {
    return {
      verdict: "no_quote",
      coverage: 0,
      note: "Kutipan terlalu pendek untuk diperiksa secara bermakna.",
    };
  }
  if (d.indexOf(q) !== -1) {
    return { verdict: "verified", coverage: 1, note: "Kutipan ditemukan verbatim dalam dokumen sumber." };
  }

  // A composite quote is judged passage by passage: the concatenation is the
  // model's, but each passage should be the document's.
  const parts = splitComposite(quote);
  if (parts.length > 1) {
    const found = parts.filter((part) => d.indexOf(normaliseForMatch(part)) !== -1).length;
    const ratio = found / parts.length;
    if (found === parts.length) {
      return {
        verdict: "verified",
        coverage: 1,
        note: `Kutipan terdiri atas ${parts.length} petikan yang seluruhnya ditemukan verbatim dalam dokumen sumber.`,
      };
    }
    if (ratio >= 0.5) {
      return {
        verdict: "paraphrased",
        coverage: ratio,
        note:
          `Dari ${parts.length} petikan dalam kutipan ini, ${found} ditemukan verbatim dalam dokumen sumber ` +
          `dan sisanya tidak. Bagian yang tidak ditemukan wajib ditelaah terhadap dokumen aslinya.`,
      };
    }
    return {
      verdict: "not_found",
      coverage: ratio,
      note:
        `Hanya ${found} dari ${parts.length} petikan dalam kutipan ini ditemukan dalam dokumen sumber yang ` +
        `dirujuk. Pernyataan ini tidak dapat diverifikasi terhadap dokumen dan wajib ditelaah sebelum diandalkan.`,
    };
  }

  // Only consulted once the document match has already failed, so a genuine quote
  // that merely resembles the example can never be misjudged as an echo.
  if (isPromptExampleQuote(quote)) {
    return {
      verdict: "not_found",
      coverage: 0,
      note:
        "Kutipan ini meniru kalimat contoh dalam instruksi analisis, bukan kalimat dokumen. " +
        "Temuan ini tidak berdasar pada dokumen sumber dan tidak boleh diandalkan.",
    };
  }

  const run = longestCommonRun(q, d);
  const coverage = run / q.length;
  if (coverage >= PARAPHRASE_THRESHOLD) {
    return {
      verdict: "paraphrased",
      coverage,
      note:
        `Kutipan tidak ditemukan verbatim; ${Math.round(coverage * 100)}% di antaranya cocok dengan dokumen sumber, ` +
        `sehingga kemungkinan merupakan parafrase dan bukan kutipan langsung.`,
    };
  }
  return {
    verdict: "not_found",
    coverage,
    note:
      "Kutipan tidak ditemukan dalam dokumen sumber yang dirujuk. Pernyataan ini tidak dapat " +
      "diverifikasi terhadap dokumen dan wajib ditelaah sebelum diandalkan.",
  };
}

/**
 * Which links of a citation chain actually appear in the source document.
 *
 * Used for the narrative's deed references: a deed number, Menkumham decree
 * number or Gazette reference that does not occur in the document it was taken
 * from was not read off that document.
 */
export function checkCitationLinks(
  links: { label: string; value: string }[],
  docText: string | undefined
): { label: string; value: string; found: boolean }[] {
  const d = docText === undefined ? "" : normaliseForMatch(docText);
  return links
    .filter((l) => l.value.trim() !== "")
    .map((l) => {
      // Compare on the identifying characters only: extraction routinely inserts
      // spaces and dots inside reference numbers.
      const needle = normaliseForMatch(l.value).replace(/[^a-z0-9]/g, "");
      const hay = d.replace(/[^a-z0-9]/g, "");
      return {
        label: l.label,
        value: l.value,
        found: needle.length >= 4 && hay.indexOf(needle) !== -1,
      };
    });
}

/** True when a verdict means the claim must not be presented as established fact. */
export function isUngrounded(v: DDGroundingVerdict): boolean {
  return v === "not_found" || v === "source_missing";
}

/**
 * Where a citation number can actually be traced to.
 *
 * "own"    the number appears in the document the report attributes it to
 * "other"  it appears elsewhere in the examined corpus but not in that document —
 *          mis-attributed, not invented
 * "absent" it appears nowhere in the examined documents
 *
 * The three-way distinction matters and a two-way one would be unfair: a deed's
 * Menkumham decree number is often legitimately read off a LATER document — a
 * shareholder register reciting the deed history, say — rather than off the deed
 * itself. Reporting that as fabrication would be wrong.
 */
export type DDCitationTrace = "own" | "other" | "absent";

const digits = (s: string) => normaliseForMatch(s).replace(/[^a-z0-9]/g, "");

export function traceCitation(
  value: string,
  ownDocText: string | undefined,
  // An array, not an Iterable: tsconfig has no downlevelIteration, so iterating
  // an Iterable here is a compile error (TS2802).
  corpus: string[]
): DDCitationTrace {
  const needle = digits(value);
  // Short reference-like strings match by accident; require real specificity.
  if (needle.length < 6) return "absent";
  if (ownDocText !== undefined && digits(ownDocText).indexOf(needle) !== -1) return "own";
  for (let i = 0; i < corpus.length; i++) {
    if (digits(corpus[i]).indexOf(needle) !== -1) return "other";
  }
  return "absent";
}

