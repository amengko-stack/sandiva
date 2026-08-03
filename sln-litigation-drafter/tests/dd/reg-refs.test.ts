import { describe, it, expect } from "vitest";
import { expandRefForQuery, isKnownInstrument } from "@/lib/dd/reg-refs";

// A live run on 2026-08-03 showed the currency check returning opposite verdicts
// for the same provision depending only on how it was written, and "unknown" for
// bare regulation numbers because the research source cannot resolve a number
// without a title. These assert the normalisation that fixes both.
describe("expandRefForQuery", () => {
  it("resolves the UUPT alias and the numeric form to the same canonical name", () => {
    const a = expandRefForQuery("UUPT Pasal 94");
    const b = expandRefForQuery("UU 40/2007 Pasal 94");
    expect(a).toBe(b);
    expect(a).toContain("UU No. 40 Tahun 2007");
    expect(a).toContain("Perseroan Terbatas");
  });

  it("always carries a title, since a bare number cannot be resolved", () => {
    for (const ref of ["POJK 17/POJK.04/2020", "POJK 42/POJK.04/2020", "PP 57/2010", "UU 8/1995"]) {
      expect(expandRefForQuery(ref), ref).toMatch(/tentang /);
    }
  });

  it("preserves the article and paragraph that was cited", () => {
    expect(expandRefForQuery("UU 40/2007 Pasal 94 ayat (1)")).toContain("Pasal 94 ayat (1)");
    expect(expandRefForQuery("UUPT Pasal 127 ayat (2)")).toContain("Pasal 127 ayat (2)");
    expect(expandRefForQuery("UU 42/1999 Pasal 14 ayat (3)")).toContain("Pasal 14 ayat (3)");
  });

  it("omits an article clause when none was cited", () => {
    expect(expandRefForQuery("PP 5/2021")).not.toMatch(/Pasal/);
  });

  it("does not let the generic UU rule swallow the UUPT/UUPM aliases", () => {
    expect(expandRefForQuery("UUPM")).toContain("Pasar Modal");
    expect(expandRefForQuery("UUWDP 3/1982 Pasal 32 ayat (1)")).toContain("Wajib Daftar Perusahaan");
    expect(expandRefForQuery("UUWDP 3/1982 Pasal 32 ayat (1)")).toContain("Pasal 32 ayat (1)");
  });

  it("returns an unknown instrument untouched rather than guessing a title", () => {
    expect(expandRefForQuery("Permen ESDM 7/2020")).toBe("Permen ESDM 7/2020");
    expect(isKnownInstrument("Permen ESDM 7/2020")).toBe(false);
    expect(isKnownInstrument("UUPT Pasal 1")).toBe(true);
  });

  it("tolerates whitespace and 'No.' variants", () => {
    const forms = ["UU 40/2007", "UU No. 40/2007", "UU No.40 / 2007"];
    const out = forms.map(expandRefForQuery);
    expect(new Set(out).size).toBe(1);
  });
});
