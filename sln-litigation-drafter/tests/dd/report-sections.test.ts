import { describe, it, expect } from "vitest";
import {
  DD_REPORT_SECTIONS,
  sectionForAspect,
  regimeSubsectionsForVII,
  DD_VII_A_FRAMING,
} from "@/config/ddReportSections";
import { DD_ASPECTS } from "@/config/ddAspects";
import { DD_TRANSACTION_TYPES } from "@/config/ddTransactionTypes";
import type { DDRegime } from "@/types/dd";

const regimeWith = (layers: DDRegime["layers"]): DDRegime => ({
  layers,
  capitalMarkets: layers.some((l) => l === "pasar_modal_langsung" || l === "pasar_modal_induk"),
  parentTbkName: layers.includes("pasar_modal_induk") ? "PT Induk Tbk" : null,
});

describe("sectionForAspect", () => {
  it("maps every DDAspectId to a section that lists it", () => {
    for (const aspect of DD_ASPECTS) {
      const section = sectionForAspect(aspect.id);
      expect(section.aspectIds).toContain(aspect.id);
    }
  });
});

describe("DD_VII_A_FRAMING", () => {
  it("has an entry for every DDTransactionType", () => {
    for (const txn of DD_TRANSACTION_TYPES) {
      const framing = DD_VII_A_FRAMING[txn.id];
      expect(framing).toBeDefined();
      expect(framing.heading.length).toBeGreaterThan(0);
      expect(framing.framing.length).toBeGreaterThan(0);
    }
  });
});

describe("regimeSubsectionsForVII", () => {
  it("VII.A is always present", () => {
    const subs = regimeSubsectionsForVII(regimeWith(["uupt"]));
    expect(subs.map((s) => s.id)).toContain("VII.A");
  });

  it("VII.B is present for pasar_modal_langsung", () => {
    const subs = regimeSubsectionsForVII(regimeWith(["uupt", "pasar_modal_langsung"]));
    expect(subs.map((s) => s.id)).toContain("VII.B");
  });

  it("VII.B is present for pasar_modal_induk", () => {
    const subs = regimeSubsectionsForVII(regimeWith(["uupt", "pasar_modal_induk"]));
    expect(subs.map((s) => s.id)).toContain("VII.B");
  });

  it("VII.B is absent for a plain uupt-only regime", () => {
    const subs = regimeSubsectionsForVII(regimeWith(["uupt"]));
    expect(subs.map((s) => s.id)).not.toContain("VII.B");
  });

  it("VII.C is present only when bumn layer is active", () => {
    const withBumn = regimeSubsectionsForVII(regimeWith(["uupt", "bumn"]));
    expect(withBumn.map((s) => s.id)).toContain("VII.C");
    const withoutBumn = regimeSubsectionsForVII(regimeWith(["uupt"]));
    expect(withoutBumn.map((s) => s.id)).not.toContain("VII.C");
  });
});

describe("DD_REPORT_SECTIONS numerals", () => {
  it("I through VIII are unique and in order", () => {
    const numerals = DD_REPORT_SECTIONS.map((s) => s.numeral);
    expect(numerals).toEqual(["I", "II", "III", "IV", "V", "VI", "VII", "VIII"]);
    expect(new Set(numerals).size).toBe(numerals.length);
  });
});
