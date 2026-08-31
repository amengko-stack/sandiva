import { describe, it, expect } from "vitest";
import { planChapters, chapterForAspect, isTransactionChapter } from "@/config/ddChapters";
import type { DDAspectId, DDRegime, DDReportFormat } from "@/types/dd";

/**
 * Analysis must reach a chapter in every format, and for both sides of a deal.
 *
 * app/api/dd/analyze/route.ts asks chapterForAspect() which sub-sections to
 * analyse; an aspect that resolves to no chapter is never sent to the model, and
 * dd-docx-builder.ts then prints "Sub-bagian ... belum dapat dianalisis" for every
 * sub-section of it. The report is structurally complete and analytically empty.
 *
 * The route already carries a comment about this defect — it was hit once when the
 * route planned with the default format while the builder planned with the chosen
 * one. That was fixed by passing the format through. The matching itself stayed
 * narrow: chapterForAspect only recognised kind "analisis_aspek", so every format
 * that carries its analysis under a different kind lost it again, silently and for
 * the same visible reason.
 *
 * exec_summary_led fuses description and analysis into "kategori" chapters.
 * A sell-side matter plans "transaksi_jual" instead of "transaksi".
 */

const regime = { layers: ["uupt"], capitalMarkets: false, parentTbkName: null } as unknown as DDRegime;

const ALL: DDAspectId[] = [
  "pendirian_ad", "permodalan_saham", "pengurus", "perizinan", "harta_kekayaan",
  "perjanjian_penting", "ketenagakerjaan", "perpajakan", "asuransi", "perkara",
];

// findings_only is excluded deliberately: it plans bare "temuan" chapters and has
// no analytical sub-sections to place, so "every aspect resolves" is not its
// contract. The formats below all render analysis prose.
const ANALYTICAL_FORMATS: DDReportFormat[] = [
  "pendahuluan_led",
  "exec_summary_led",
  "lut_pasar_modal",
];

const plan = (format: DDReportFormat, clientRole = "pembeli") =>
  planChapters({
    transactionType: "akuisisi_saham",
    regime,
    presentAspects: ALL,
    format,
    clientRole,
  });

describe("analysis reaches a chapter in every analytical format", () => {
  for (const format of ANALYTICAL_FORMATS) {
    it(`${format}: every present aspect resolves to a chapter`, () => {
      const p = plan(format);
      const orphaned = ALL.filter((a) => chapterForAspect(p, a) === null);
      expect(orphaned).toEqual([]);
    });
  }
});

describe("sell-side matters get their transaction chapters analysed", () => {
  // The analyze route collects transaction sub-sections with
  // `if (ch.kind !== "transaksi") continue`. planChapters emits "transaksi_jual"
  // when the client is the seller, so that loop collected nothing and every
  // sub-section fell back to the "Penjual wajib mengonfirmasi" boilerplate.
  it("plans a sell-side transaction block that carries sub-sections", () => {
    const sell = plan("pendahuluan_led", "penjual");
    const sellChapters = sell.filter((c) => c.kind === "transaksi_jual");
    expect(sellChapters.length).toBeGreaterThan(0);
    expect(sellChapters.some((c) => c.subs.length > 0)).toBe(true);
  });

  // isTransactionChapter is the predicate the analyze route actually uses, imported
  // rather than restated here — a copy in the test would pass while the route kept
  // its own narrower check, which is precisely how this shipped.
  it("finds transaction sub-sections to analyse on both sides of the deal", () => {
    const subsUnder = (role: string) =>
      plan("pendahuluan_led", role)
        .filter(isTransactionChapter)
        .flatMap((c) => c.subs.map((s) => s.title));

    expect(subsUnder("pembeli").length).toBeGreaterThan(0);
    expect(subsUnder("penjual").length).toBeGreaterThan(0);
  });
});
