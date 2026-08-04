import { describe, it, expect } from "vitest";
import { planChapters } from "@/config/ddChapters";
import { DD_ASPECTS } from "@/config/ddAspects";
import { resolveRegime } from "@/lib/dd/regime";
import type { DDAspectId, DDEntity, DDReportFormat } from "@/types/dd";

// Format is a deliverable choice driven by client need. The firm's own samples use
// two different shapes for comparable work:
//   LDD_SIIB / LDD_PT_ITDC       -> Pendahuluan, Profil, analysis per aspect
//   LDD_Report_SBN_Divestment    -> Ringkasan Eksekutif, then document-category
//                                   chapters with description and analysis fused
// and the SBN one is a SELLER's report, which changes the transaction chapters.

const entity = (over: Partial<DDEntity> = {}): DDEntity => ({
  id: "e1", name: "PT Alpha", role: "target", dataRoomPath: "x", files: [], ...over,
});

const ALL: DDAspectId[] = DD_ASPECTS.map((a) => a.id);

const plan = (o: {
  format?: DDReportFormat; ent?: DDEntity; aspects?: DDAspectId[];
  type?: Parameters<typeof planChapters>[0]["transactionType"];
  clientRole?: string; implications?: boolean;
} = {}) =>
  planChapters({
    transactionType: o.type ?? "akuisisi_saham",
    regime: resolveRegime(o.ent ?? entity()),
    presentAspects: o.aspects ?? ALL,
    format: o.format,
    clientRole: o.clientRole,
    transactionImplications: o.implications,
  });

const titles = (p: ReturnType<typeof planChapters>) => p.map((c) => c.title);
const kinds = (p: ReturnType<typeof planChapters>) => p.map((c) => c.kind);

describe("format: default is unchanged", () => {
  it("omitting the format reproduces the pendahuluan_led plan", () => {
    expect(titles(plan())).toEqual(titles(plan({ format: "pendahuluan_led" })));
    expect(kinds(plan())[0]).toBe("pendahuluan");
  });
});

describe("format: exec_summary_led", () => {
  it("opens with Ringkasan Eksekutif and has no Pendahuluan chapter", () => {
    const p = plan({ format: "exec_summary_led" });
    expect(p[0].kind).toBe("ringkasan");
    expect(kinds(p)).not.toContain("pendahuluan");
    expect(kinds(p)).not.toContain("profil");
  });

  it("organises chapters by document category with bilingual titles", () => {
    const t = titles(plan({ format: "exec_summary_led" }));
    expect(t).toContain("INFORMASI KORPORASI (CORPORATE INFORMATION)");
    expect(t).toContain("IZIN-IZIN USAHA (LICENSES AND PERMITS)");
    expect(t).toContain("KETENAGAKERJAAN (LABOUR)");
    expect(t).toContain("PERKARA HUKUM (LITIGATION)");
    expect(t).toContain("PERPAJAKAN (TAX MATTERS)");
  });

  // The builder strips the gloss when bilingualHeadings is off, so the English
  // must sit in a single trailing parenthetical.
  it("keeps the English gloss strippable by one regex", () => {
    for (const c of plan({ format: "exec_summary_led" }).filter((x) => x.kind === "kategori")) {
      const stripped = c.title.replace(/\s*\([A-Z][^)]*\)$/, "");
      expect(stripped, c.title).not.toMatch(/\($/);
      expect(stripped.length, c.title).toBeGreaterThan(3);
    }
  });

  it("adds a per-chapter transaction implication sub-section only when asked", () => {
    const without = plan({ format: "exec_summary_led" });
    const withImp = plan({ format: "exec_summary_led", implications: true });
    const subsOf = (p: ReturnType<typeof planChapters>) =>
      p.filter((c) => c.kind === "kategori").flatMap((c) => c.subs.map((s) => s.title));
    expect(subsOf(without).some((s) => /Implikasi/i.test(s))).toBe(false);
    expect(subsOf(withImp).some((s) => /Implikasi/i.test(s))).toBe(true);
  });

  it("still omits category chapters whose aspects have no documents", () => {
    const t = titles(plan({ format: "exec_summary_led", aspects: ["pendirian_ad"] }));
    expect(t).toContain("INFORMASI KORPORASI (CORPORATE INFORMATION)");
    expect(t).not.toContain("KETENAGAKERJAAN (LABOUR)");
  });
});

// The SBN report is a seller's report: it does not ask whether the seller may
// transfer, it proves it. So the transaction chapters differ by client role.
describe("format: sell-side transaction chapters", () => {
  it("replaces the buy-side chapter when acting for the seller", () => {
    const buy = titles(plan({ type: "divestasi", clientRole: "pembeli" }));
    const sell = titles(plan({ type: "divestasi", clientRole: "penjual" }));

    expect(sell).toContain("ANALISIS CLEAN TITLE (KEABSAHAN OBJEK JUAL)");
    expect(sell).toContain("KESIAPAN DATA ROOM");
    expect(sell).toContain("ISU YANG PERLU DIUNGKAPKAN KEPADA PEMBELI");
    expect(sell).toContain("KEWAJIBAN PENJUAL PASCA-CLOSING");

    // Replacement, not addition.
    expect(sell).not.toContain("KEPATUHAN PROSEDUR PENGAMBILALIHAN SAHAM");
    expect(buy).toContain("KEPATUHAN PROSEDUR PENGAMBILALIHAN SAHAM");
    expect(buy).not.toContain("ANALISIS CLEAN TITLE (KEABSAHAN OBJEK JUAL)");
  });

  it("matches the role case-insensitively and in English", () => {
    for (const role of ["penjual", "Penjual", "SELLER", "seller (divesting shareholder)"]) {
      expect(titles(plan({ type: "divestasi", clientRole: role })), role)
        .toContain("KESIAPAN DATA ROOM");
    }
  });

  it("does not fire for a buyer, an unstated role, or a dissolution", () => {
    for (const args of [
      { type: "divestasi" as const },
      { type: "divestasi" as const, clientRole: "pembeli" },
      { type: "likuidasi" as const, clientRole: "penjual" },
    ]) {
      expect(titles(plan(args)), JSON.stringify(args)).not.toContain("KESIAPAN DATA ROOM");
    }
  });

  it("applies to both formats, not only the one it was found in", () => {
    for (const format of ["pendahuluan_led", "exec_summary_led"] as const) {
      expect(titles(plan({ format, type: "divestasi", clientRole: "penjual" })), format)
        .toContain("ANALISIS CLEAN TITLE (KEABSAHAN OBJEK JUAL)");
    }
  });
});

describe("format: findings_only", () => {
  it("carries no profile chapter and no per-aspect analysis sub-sections", () => {
    const p = plan({ format: "findings_only" });
    expect(kinds(p)).not.toContain("profil");
    expect(kinds(p)).not.toContain("analisis_aspek");
    expect(p[0].kind).toBe("ringkasan");
    expect(kinds(p)).toContain("rekomendasi");
  });

  it("emits one findings chapter per aspect present, and fewer when fewer apply", () => {
    const many = plan({ format: "findings_only" }).filter((c) => c.kind === "temuan");
    const few = plan({ format: "findings_only", aspects: ["perizinan"] }).filter((c) => c.kind === "temuan");
    expect(many.length).toBeGreaterThan(few.length);
    for (const c of many) {
      expect(c.subs.filter((s) => s.findings).length, c.title).toBe(1);
    }
  });
});

describe("format: lut_pasar_modal", () => {
  it("keeps Pendahuluan and always emits the capital-markets chapter", () => {
    // The format exists only because the target is Tbk / feeds a prospectus, so
    // the chapter is unconditional here rather than gated on the regime.
    const p = plan({ format: "lut_pasar_modal" });
    expect(kinds(p)[0]).toBe("pendahuluan");
    expect(kinds(p)).toContain("pasar_modal");
    expect(kinds(plan({ format: "lut_pasar_modal", ent: entity({ listingStatus: "non_tbk" }) })))
      .toContain("pasar_modal");
  });

  it("covers the mandatory examination areas the standard prescribes", () => {
    const t = titles(plan({ format: "lut_pasar_modal" })).join(" | ").toLowerCase();
    for (const area of ["anggaran dasar", "permodalan", "perizinan", "harta kekayaan", "asuransi", "ketenagakerjaan", "perkara"]) {
      expect(t, area).toContain(area);
    }
    // Areas 2 and 7 are the ones the dissolution reference report lacks entirely.
    expect(t).toMatch(/risalah/);
    expect(t).toMatch(/laporan keuangan/);
  });
});

describe("format: every format is well-formed", () => {
  const FORMATS: DDReportFormat[] = ["pendahuluan_led", "exec_summary_led", "lut_pasar_modal", "findings_only"];

  it("ends with Lampiran then Disclaimer, both outside the numeral sequence", () => {
    for (const format of FORMATS) {
      const p = plan({ format });
      expect(kinds(p).slice(-2), format).toEqual(["lampiran", "disclaimer"]);
      for (const c of p) {
        if (c.kind === "lampiran" || c.kind === "disclaimer") expect(c.numeral, format).toBe("");
        else expect(c.numeral, `${format}/${c.title}`).not.toBe("");
      }
    }
  });

  it("numbers chapters uniquely and in sequence", () => {
    for (const format of FORMATS) {
      const numerals = plan({ format }).map((c) => c.numeral).filter(Boolean);
      expect(new Set(numerals).size, format).toBe(numerals.length);
      expect(numerals[0], format).toBe("I");
    }
  });

  it("gives every chapter a non-empty title", () => {
    for (const format of FORMATS) {
      for (const c of plan({ format })) {
        expect(c.title.trim().length, `${format}/${c.kind}`).toBeGreaterThan(3);
      }
    }
  });
});

// A Tbk is bound by UUPT *and* the capital-markets overlay. My first spec for
// this format omitted the UUPT transaction block, which would have left a Tbk
// report with no UUPT compliance at all — the same conflation of the two regimes
// that this codebase exists to avoid.
describe("format: lut_pasar_modal still carries the UUPT baseline", () => {
  it("emits both the UUPT transaction block and the capital-markets chapter", () => {
    const p = plan({ format: "lut_pasar_modal", ent: entity({ listingStatus: "tbk" }) });
    expect(kinds(p)).toContain("transaksi");
    expect(kinds(p)).toContain("pasar_modal");
    expect(titles(p)).toContain("KEPATUHAN PROSEDUR PENGAMBILALIHAN SAHAM");
    expect(titles(p)).toContain("KEPATUHAN KETENTUAN PASAR MODAL");
  });

  it("uses the sell-side block here too when acting for the seller", () => {
    const t = titles(plan({
      format: "lut_pasar_modal", type: "divestasi", clientRole: "penjual",
      ent: entity({ listingStatus: "tbk" }),
    }));
    expect(t).toContain("ANALISIS CLEAN TITLE (KEABSAHAN OBJEK JUAL)");
    expect(t).not.toContain("KEPATUHAN PROSEDUR PENGAMBILALIHAN SAHAM");
  });
});

// Stage 5 hands analyzeAspect the sub-section titles it must fill, and the builder
// looks the resulting analyses up BY TITLE. If the two plan with different
// formats, nothing matches and every sub-section falls back to "belum dapat
// dianalisis" — the empty-chapters defect, reintroduced for any non-default
// format. This asserts the titles genuinely differ, which is why both sides must
// be given the same format.
describe("sub-section titles diverge between formats", () => {
  const subsFor = (format: DDReportFormat) =>
    plan({ format })
      .filter((c) => c.kind === "analisis_aspek" || c.kind === "kategori" || c.kind === "temuan")
      .flatMap((c) => c.subs.filter((s) => !s.findings).map((s) => s.title));

  it("gives the corporate material different sub-section titles per format", () => {
    const a = subsFor("pendahuluan_led");
    const b = subsFor("exec_summary_led");
    expect(a).toContain("Keabsahan Pendirian dan Anggaran Dasar");
    expect(b).toContain("Riwayat Pendirian dan Akta Perubahan");
    // Barely any overlap: planning with the wrong format loses nearly everything.
    const shared = a.filter((t) => b.indexOf(t) !== -1);
    expect(shared.length).toBeLessThan(Math.min(a.length, b.length) / 2);
  });

  it("changes the sub-sections again when the client is the seller", () => {
    const buy = plan({ type: "divestasi", clientRole: "pembeli" })
      .filter((c) => c.kind === "transaksi").flatMap((c) => c.subs.map((s) => s.title));
    const sell = plan({ type: "divestasi", clientRole: "penjual" })
      .filter((c) => c.kind === "transaksi_jual").flatMap((c) => c.subs.map((s) => s.title));
    expect(sell.length).toBeGreaterThan(0);
    expect(sell.filter((t) => buy.indexOf(t) !== -1)).toEqual([]);
  });
});
