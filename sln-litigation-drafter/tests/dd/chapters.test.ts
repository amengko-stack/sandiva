import { describe, it, expect } from "vitest";
import { chapterForAspect, planChapters, subNumber } from "@/config/ddChapters";
import { DD_ASPECTS } from "@/config/ddAspects";
import { DD_TRANSACTION_TYPES } from "@/config/ddTransactionTypes";
import { resolveRegime } from "@/lib/dd/regime";
import type { DDAspectId, DDEntity } from "@/types/dd";

const entity = (over: Partial<DDEntity> = {}): DDEntity => ({
  id: "e1", name: "PT Alpha", role: "target", dataRoomPath: "x", files: [], ...over,
});

const ALL: DDAspectId[] = DD_ASPECTS.map((a) => a.id);
const plan = (over: { type?: Parameters<typeof planChapters>[0]["transactionType"]; ent?: DDEntity; aspects?: DDAspectId[] } = {}) =>
  planChapters({
    transactionType: over.type ?? "akuisisi_saham",
    regime: resolveRegime(over.ent ?? entity()),
    presentAspects: over.aspects ?? ALL,
  });

const titles = (p: ReturnType<typeof planChapters>) => p.map((c) => c.title);

describe("planChapters — house BAB format", () => {
  it("always opens with Pendahuluan and Profil, and closes with Kesimpulan, Lampiran, Disclaimer", () => {
    const p = plan();
    expect(p[0].kind).toBe("pendahuluan");
    expect(p[1].kind).toBe("profil");
    const kinds = p.map((c) => c.kind);
    expect(kinds.slice(-3)).toEqual(["kesimpulan", "lampiran", "disclaimer"]);
  });

  it("numbers only the numbered chapters, leaving Lampiran and Disclaimer outside the sequence", () => {
    const p = plan();
    const numbered = p.filter((c) => c.kind !== "lampiran" && c.kind !== "disclaimer");
    expect(numbered.map((c) => c.numeral)).toEqual(
      ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"].slice(0, numbered.length)
    );
    for (const c of p) {
      if (c.kind === "lampiran" || c.kind === "disclaimer") expect(c.numeral).toBe("");
    }
  });

  // The reference report is a dissolution. Copying its chapters verbatim would put
  // liquidator and asset-liquidation chapters into a share acquisition.
  it("gives a dissolution the liquidation chapter block and nobody else", () => {
    const liq = titles(plan({ type: "likuidasi" }));
    expect(liq).toContain("DASAR DAN ALASAN PEMBUBARAN");
    expect(liq).toContain("ANALISIS LIKUIDATOR");
    expect(liq).toContain("PROSES PEMBUBARAN DAN LIKUIDASI");

    const acq = titles(plan({ type: "akuisisi_saham" }));
    expect(acq).not.toContain("ANALISIS LIKUIDATOR");
    expect(acq).not.toContain("DASAR DAN ALASAN PEMBUBARAN");
    expect(acq).toContain("KEPATUHAN PROSEDUR PENGAMBILALIHAN SAHAM");
  });

  it("gives every transaction type exactly one transaction block, including the generic fallback", () => {
    for (const t of DD_TRANSACTION_TYPES) {
      const p = plan({ type: t.id });
      const txn = p.filter((c) => c.kind === "transaksi");
      expect(txn.length, t.id).toBeGreaterThan(0);
      for (const c of txn) {
        expect(c.title.length, t.id).toBeGreaterThan(5);
        expect(c.subs.length, t.id).toBeGreaterThan(0);
      }
    }
    // streamlining and joint_venture have no bespoke statutory sequence.
    for (const t of ["streamlining", "joint_venture"] as const) {
      expect(titles(plan({ type: t }))).toContain("KEPATUHAN ASPEK KORPORASI TRANSAKSI");
    }
  });

  it("adds the capital-markets chapter only when a capital-markets layer applies, and names it for the case", () => {
    expect(titles(plan())).not.toContain("KEPATUHAN KETENTUAN PASAR MODAL");

    const tbk = titles(plan({ ent: entity({ listingStatus: "tbk" }) }));
    expect(tbk).toContain("KEPATUHAN KETENTUAN PASAR MODAL");

    const viaParent = titles(plan({ ent: entity({ listingStatus: "non_tbk", ultimateParentTbk: "PT Induk Tbk" }) }));
    expect(viaParent).toContain("KEPATUHAN KETENTUAN PASAR MODAL PADA TINGKAT INDUK");
    expect(viaParent).not.toContain("KEPATUHAN KETENTUAN PASAR MODAL");
  });

  it("adds the BUMN chapter only under the BUMN layer", () => {
    expect(titles(plan())).not.toContain("LAPISAN BADAN USAHA MILIK NEGARA");
    expect(titles(plan({ ent: entity({ isBumn: true }) }))).toContain("LAPISAN BADAN USAHA MILIK NEGARA");
  });

  // A chapter with nothing in it reads as an omission to a client.
  it("omits analysis chapters for aspects with no documents, but always keeps the corporate chapter", () => {
    const sparse = plan({ aspects: ["pendirian_ad"] });
    expect(titles(sparse)).toContain("ANALISIS KORPORASI");
    expect(titles(sparse)).not.toContain("ANALISIS KETENAGAKERJAAN");
    expect(titles(sparse)).not.toContain("ANALISIS PERPAJAKAN");

    // With no aspects at all the corporate chapter still stands.
    expect(titles(plan({ aspects: [] }))).toContain("ANALISIS KORPORASI");
  });

  it("routes every aspect to exactly one analysis chapter when all are present", () => {
    const p = plan();
    for (const a of DD_ASPECTS) {
      const ch = chapterForAspect(p, a.id);
      expect(ch, a.id).not.toBeNull();
      expect(ch!.aspectIds, a.id).toContain(a.id);
      const matches = p.filter((c) => c.kind === "analisis_aspek" && c.aspectIds.indexOf(a.id) !== -1);
      expect(matches.length, a.id).toBe(1);
    }
  });

  it("closes each analysis chapter with a findings sub-section", () => {
    for (const c of plan().filter((x) => x.kind === "analisis_aspek")) {
      const last = c.subs[c.subs.length - 1];
      expect(last.findings, c.title).toBe(true);
      expect(c.subs.filter((s) => s.findings).length, c.title).toBe(1);
    }
  });

  it("covers the HKHSK mandatory areas that the dissolution reference report lacks", () => {
    // Areas 7 (audited financial statements) and 8 (insurance) are mandatory for
    // an examination even though the reference dissolution report has no chapter
    // for them.
    const t = titles(plan());
    expect(t).toContain("ANALISIS PERPAJAKAN");
    expect(t).toContain("ANALISIS HARTA KEKAYAAN DAN ASURANSI");
  });

  it("numbers sub-sections decimally", () => {
    expect(subNumber(1, 0)).toBe("1.1");
    expect(subNumber(3, 4)).toBe("3.5");
    expect(subNumber(12, 0)).toBe("12.1");
  });
});
