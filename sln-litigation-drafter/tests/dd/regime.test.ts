import { describe, it, expect } from "vitest";
import { resolveRegime, regimeGuardText, obligationsForLayer } from "@/lib/dd/regime";
import type { DDEntity } from "@/types/dd";

const baseEntity = (overrides: Partial<DDEntity> = {}): DDEntity => ({
  id: "target",
  name: "PT Contoh",
  role: "target",
  dataRoomPath: "/x",
  files: [],
  ...overrides,
});

describe("resolveRegime", () => {
  it("absent listingStatus resolves to plain uupt-only regime", () => {
    const r = resolveRegime(baseEntity());
    expect(r.layers).toEqual(["uupt"]);
    expect(r.capitalMarkets).toBe(false);
    expect(r.parentTbkName).toBeNull();
  });

  it("non_tbk with no parent behaves the same as absent listingStatus", () => {
    const r = resolveRegime(baseEntity({ listingStatus: "non_tbk" }));
    expect(r.layers).toEqual(["uupt"]);
    expect(r.capitalMarkets).toBe(false);
    expect(r.parentTbkName).toBeNull();
  });

  it("tbk resolves to uupt + pasar_modal_langsung, capitalMarkets true, parentTbkName null even with ultimateParentTbk set", () => {
    const r = resolveRegime(
      baseEntity({ listingStatus: "tbk", ultimateParentTbk: "PT Induk Tbk" })
    );
    expect(r.layers).toEqual(["uupt", "pasar_modal_langsung"]);
    expect(r.capitalMarkets).toBe(true);
    expect(r.parentTbkName).toBeNull();
  });

  it("non_tbk with ultimateParentTbk resolves to uupt + pasar_modal_induk with parent name set", () => {
    const r = resolveRegime(
      baseEntity({
        listingStatus: "non_tbk",
        ultimateParentTbk: "PT Semen Indonesia (Persero) Tbk",
      })
    );
    expect(r.layers).toEqual(["uupt", "pasar_modal_induk"]);
    expect(r.capitalMarkets).toBe(true);
    expect(r.parentTbkName).toBe("PT Semen Indonesia (Persero) Tbk");
  });

  it("whitespace-only ultimateParentTbk is treated as absent", () => {
    const r = resolveRegime(
      baseEntity({ listingStatus: "non_tbk", ultimateParentTbk: "   " })
    );
    expect(r.layers).toEqual(["uupt"]);
    expect(r.capitalMarkets).toBe(false);
    expect(r.parentTbkName).toBeNull();
  });

  it("isBumn adds the bumn layer without duplicating other layers", () => {
    const r = resolveRegime(baseEntity({ isBumn: true }));
    expect(r.layers).toEqual(["uupt", "bumn"]);
  });

  it("isBumn combined with tbk adds bumn without duplication", () => {
    const r = resolveRegime(baseEntity({ listingStatus: "tbk", isBumn: true }));
    expect(r.layers).toEqual(["uupt", "pasar_modal_langsung", "bumn"]);
    expect(new Set(r.layers).size).toBe(r.layers.length);
  });

  it("isBumn combined with pasar_modal_induk adds bumn without duplication", () => {
    const r = resolveRegime(
      baseEntity({
        listingStatus: "non_tbk",
        ultimateParentTbk: "PT Induk Tbk",
        isBumn: true,
      })
    );
    expect(r.layers).toEqual(["uupt", "pasar_modal_induk", "bumn"]);
    expect(new Set(r.layers).size).toBe(r.layers.length);
  });

  it("never produces duplicate layers in any combination", () => {
    const combos: DDEntity[] = [
      baseEntity(),
      baseEntity({ listingStatus: "non_tbk" }),
      baseEntity({ listingStatus: "tbk" }),
      baseEntity({ listingStatus: "tbk", isBumn: true }),
      baseEntity({ listingStatus: "non_tbk", ultimateParentTbk: "PT Induk Tbk" }),
      baseEntity({ listingStatus: "non_tbk", ultimateParentTbk: "PT Induk Tbk", isBumn: true }),
      baseEntity({ isBumn: true }),
    ];
    for (const e of combos) {
      const r = resolveRegime(e);
      expect(new Set(r.layers).size).toBe(r.layers.length);
    }
  });
});

describe("regimeGuardText", () => {
  it("prohibits citing POJK/capital-markets rules for a plain non-Tbk entity", () => {
    const r = resolveRegime(baseEntity());
    const text = regimeGuardText(r, "PT Contoh");
    expect(text).toContain("Rezim pasar modal TIDAK BERLAKU");
    expect(text).toContain("JANGAN mengutip UU Pasar Modal, POJK apa pun");
  });

  it("names the parent and places obligations at the parent for the via-parent case", () => {
    const r = resolveRegime(
      baseEntity({ listingStatus: "non_tbk", ultimateParentTbk: "PT Induk Tbk" })
    );
    const text = regimeGuardText(r, "PT Contoh");
    expect(text).toContain("PT Induk Tbk");
    expect(text).toContain("bukan di tingkat PT Contoh");
  });

  it("requires the material-transaction threshold test for the Tbk case", () => {
    const r = resolveRegime(baseEntity({ listingStatus: "tbk" }));
    const text = regimeGuardText(r, "PT Contoh");
    expect(text).toContain("wajib menguji ambang Transaksi Material");
  });
});

describe("obligationsForLayer", () => {
  it("includes liquidation-specific items for likuidasi", () => {
    const obs = obligationsForLayer("uupt", "likuidasi");
    const ids = obs.map((o) => o.id);
    expect(ids).toContain("uupt.likuidasi_pengumuman");
    expect(ids).toContain("uupt.likuidasi_klaim_kreditor");
  });

  it("excludes liquidation-specific items for akuisisi_saham", () => {
    const obs = obligationsForLayer("uupt", "akuisisi_saham");
    const ids = obs.map((o) => o.id);
    expect(ids).not.toContain("uupt.likuidasi_pengumuman");
    expect(ids).not.toContain("uupt.likuidasi_klaim_kreditor");
  });
});
