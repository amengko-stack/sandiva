"""Regenerate config/manpowerStructure.ts.

    python scripts/gen-manpower-structure.py \
        data/statutes/uu13-2003.txt <uu6-2023-naker.txt> config/manpowerStructure.ts

The second argument is text extracted from the Ministry of Manpower's published
extract of the Cipta Kerja manpower cluster:

    https://jdih.kemnaker.go.id/asset/data_puu/2023UU06_Naker.pdf

That PDF is a scan. Its OCR drops item numbers, writes "Pasa1" for "Pasal", "(21"
for "(2)", "9O" for "90", and loses the space before "dihapus" — so nothing here is
taken on trust:

  * The cluster is bounded at BOTH ends. Pasal 81 amends UU 13/2003; the articles
    after it amend other statutes, each opening with its own "...diubah sebagai
    berikut:". Reading past the first attributes another law's amendments to this one.
  * Completeness is proved by exhaustive accounting, not by item numbers (some are
    missing from the scan entirely). Every "dihapus"/"diubah" inside the cluster must
    be claimed by a parsed statement; leftovers abort the run rather than pass
    silently. The counts then close against the numbering: 28 repealed + 34 amended +
    8 insertion items + 1 heading change = 71, the highest item number in the list.
  * Insertions are read from the "yakni Pasal ..." list and checked against the count
    the sentence itself declares.

The paragraph structure comes only from the clean 2003 text, never from the scan.
Articles the amendment touched are recorded but not structured — see the header this
writes into the generated file for why.
"""
import io, json, re, sys

DIGITS = str.maketrans({"O": "0", "o": "0", "l": "1", "I": "1", "S": "5"})
PASAL = r"Pasa[l1]"
NUM = r"[0-9OolIS]{1,3}[A-Z]?"
art_key = lambda s: (int(re.sub(r"\D", "", s)), s)


def article_no(raw):
    m = re.fullmatch(r"(\d{1,3})([A-Z]?)", raw.translate(DIGITS))
    return m.group(1) + m.group(2) if m else None


def parse_2003(text):
    """Mirrors parseStatute() in lib/dd/statute.ts. The TS test re-derives this map
    with the TS parser, so a drift between the two fails the suite."""
    cut = re.search(r"^\s*P\s?E\s?N\s?J\s?E\s?L\s?A\s?S\s?A\s?N\s*$", text, re.M)
    lines = (text[: cut.start()] if cut else text).split("\n")
    heads = [(m.group(1), i) for i, l in enumerate(lines)
             if (m := re.match(r"^\s*Pasal\s+(\d+[A-Z]?)\s*$", l))]
    bodies = {}
    for k, (no, at) in enumerate(heads):
        end = heads[k + 1][1] if k + 1 < len(heads) else len(lines)
        body = re.sub(r"\s+", " ", " ".join(lines[at + 1:end])).strip()
        if no not in bodies or len(body) > len(bodies[no]):
            bodies[no] = body
    return bodies


def find_ayat(body, n):
    i = body.find(f"({n})")
    if i != -1:
        return i
    m = re.search(rf"(^|[^0-9(]){n}\)", body)
    return m.start() + len(m.group(1)) if m else -1


def ayat_text(body, n):
    s = find_ayat(body, n)
    if s == -1:
        return None
    e = find_ayat(body, n + 1)
    return body[s: e if e != -1 and e > s else len(body)]


def letters(scope):
    out = ""
    for L in "abcdefghijklmnopqrstuvwxyz":
        if not re.search(rf"(^|[\s;]){L}\.", scope):
            break
        out += L
    return out


def parse_cipta_kerja(raw):
    full = re.sub(r"\s+", " ", raw)
    chapeau = re.compile(r"diubah sebagai berikut\s*:", re.I)
    start = full.find("Beberapa ketentuan dalam Undang-Undang Nomor 13 Tahun 2003")
    if start == -1:
        raise SystemExit("manpower chapeau not found — wrong source document?")
    first = chapeau.search(full, start)
    nxt = chapeau.search(full, first.end())
    end = nxt.start() if nxt else len(full)
    if "Beberapa ketentuan" in full[first.end():end]:
        end = full.rfind("Beberapa ketentuan", first.end(), end)
    cluster = full[first.end():end]

    deleted, amended, spans = set(), set(), []
    for m in re.finditer(rf"(?:Ketentuan\s+){{0,1}}{PASAL}\s*({NUM})\s*(diubah|dihapus)", cluster, re.I):
        a = article_no(m.group(1))
        if a is None:
            continue
        (deleted if m.group(2).lower() == "dihapus" else amended).add(a)
        spans.append((m.start(), m.end()))

    inserted, ins_items = set(), 0
    for m in re.finditer(
        rf"Di\s+antara\s+{PASAL}\s*{NUM}\s+dan\s+{PASAL}\s*{NUM}\s+disisipkan\s+(\d+).{{0,20}}?yakni\s+(.*?)\s+sehingga",
        cluster, re.I,
    ):
        ins_items += 1
        names = {article_no(x) for x in re.findall(rf"{PASAL}\s*({NUM})", m.group(2), re.I)}
        names = {n for n in names if n and re.fullmatch(r"\d{1,3}[A-Z]", n)}
        if len(names) != int(m.group(1)):
            raise SystemExit(f"insertion declares {m.group(1)} articles, named {sorted(names)}")
        inserted |= names

    claimed = lambda i: any(s <= i < e for s, e in spans)
    leftover = [cluster[max(0, m.start() - 80):m.start() + 20]
                for m in re.finditer(r"\b(dihapus|diubah)\b", cluster, re.I)
                if not claimed(m.start())]
    # One heading change ("Judul Paragraf 1 pada BAB X diubah") is expected; anything
    # else is an amendment this parser did not understand and must not be dropped.
    unexplained = [c for c in leftover if "Judul" not in c]
    if unexplained:
        raise SystemExit("unclaimed amendment statements:\n  " + "\n  ".join(unexplained))

    overlap = (deleted & amended) | (deleted & inserted) | (amended & inserted)
    if overlap:
        raise SystemExit(f"article in two categories at once: {sorted(overlap, key=art_key)}")

    total = len(deleted) + len(amended) + ins_items + len(leftover)
    highest = max(int(m.group(1)) for m in
                  re.finditer(r"(?<![\d,])(\d{1,2})\.\s*(?:Ketentuan|Pasa[l1]|Di antara|Judul)", cluster))
    if total != highest:
        raise SystemExit(f"counts do not close: {total} statements vs highest item {highest}")
    return deleted, amended, inserted, ins_items, highest


def main():
    src, ck_src, out = sys.argv[1], sys.argv[2], sys.argv[3]
    bodies = parse_2003(io.open(src, encoding="utf-8").read())

    structure = {}
    for no, body in bodies.items():
        ayats, n = {}, 1
        while (a := ayat_text(body, n)) is not None:
            ayats[str(n)] = letters(a)
            n += 1
        structure[no] = ayats or {"0": letters(body)}

    deleted, amended, inserted, ins_items, highest = parse_cipta_kerja(
        io.open(ck_src, encoding="utf-8").read()
    )

    missing = sorted((deleted | amended) - set(structure), key=art_key)
    if missing:
        raise SystemExit(f"Cipta Kerja touches articles absent from UU 13/2003: {missing}")
    already = sorted(inserted & set(structure), key=art_key)
    if already:
        raise SystemExit(f"Cipta Kerja 'inserts' articles the 2003 text already has: {already}")
    for a in sorted(inserted):
        structure[a] = {}

    def rows(d):
        return "\n".join(
            f'  "{no}":{{' + ",".join(f'"{k}":"{v}"' for k, v in sorted(d[no].items(), key=lambda kv: int(kv[0]))) + "},"
            for no in sorted(d, key=art_key)
        )

    def members(s):
        return "\n".join(f'  "{a}",' for a in sorted(s, key=art_key))

    io.open(out, "w", encoding="utf-8", newline="\n").write(f'''/**
 * The STRUCTURE of UU 13/2003 (Ketenagakerjaan), and what UU 6/2023 (Cipta Kerja)
 * did to each article.
 *
 * GENERATED by scripts/gen-manpower-structure.py — do not edit by hand.
 *
 * UUPT could be checked against its own text alone, because it is in force as
 * enacted. This statute cannot. Cipta Kerja deleted {len(deleted)} of these articles, rewrote
 * {len(amended)}, and inserted {len(inserted)} that the 2003 text has never contained — so both directions
 * are traps. Checking against the 2003 text alone confirms Pasal 91, deleted in 2023,
 * and calls Pasal 61A missing when it is a real provision. The second of those is the
 * worse failure: a checker that accuses a lawyer of inventing a citation they got
 * right is worse than no checker, and this one did exactly that against a real report
 * before insertions were recorded.
 *
 * Ayat and huruf are NOT recorded for an article Cipta Kerja touched. For a rewritten
 * article the paragraph structure here is the superseded one; for an inserted article
 * the only text available is a scan whose OCR writes "(21" for "(2)". Judging a
 * citation against either would manufacture defects instead of finding them, so the
 * checker stops at article level for all {len(amended) + len(inserted)} of them.
 *
 * The repeal and amendment lists come from UU 6/2023 Pasal 81 as published by the
 * Ministry of Manpower — a scan. The generator does not trust it: it bounds the
 * manpower cluster at both ends, requires every "dihapus"/"diubah" inside it to be
 * claimed by a parsed statement, and checks the totals close against the law's own
 * numbering ({len(deleted)} repealed + {len(amended)} amended + {ins_items} insertion items + 1 heading = {highest}).
 */

/** Articles UU 6/2023 deleted. Citing one cites a provision that no longer exists. */
export const MANPOWER_REPEALED: ReadonlySet<string> = new Set([
{members(deleted)}
]);

/** Articles UU 6/2023 rewrote. They exist, but not in the words recorded below. */
export const MANPOWER_AMENDED: ReadonlySet<string> = new Set([
{members(amended)}
]);

/** Articles UU 6/2023 added. Real, and absent from the 2003 text by definition. */
export const MANPOWER_INSERTED: ReadonlySet<string> = new Set([
{members(inserted)}
]);

/** article -> ayat -> the lettered items in that ayat ("0" = article with no ayat). */
export const MANPOWER_STRUCTURE: Record<string, Record<string, string>> = {{
{rows(structure)}
}};
''')
    print(f"articles {len(structure)}  repealed {len(deleted)}  "
          f"amended {len(amended)}  inserted {len(inserted)}  (items close at {highest})")


if __name__ == "__main__":
    main()
