import { describe, it, expect } from "vitest";
import { buildChecklistWorkbook, parseChecklistWorkbook, resolveChecklist } from "@/lib/dd/checklist-loader";
import { SEED_CHECKLIST } from "@/config/ddChecklist.seed";

describe("checklist workbook round-trip", () => {
  it("build → parse preserves docs, overlays, and extraction fields", async () => {
    const buf = await buildChecklistWorkbook(SEED_CHECKLIST);
    const parsed = await parseChecklistWorkbook(buf);

    expect(parsed.version).toBe(SEED_CHECKLIST.version);
    expect(parsed.base.map((d) => d.id).sort()).toEqual(SEED_CHECKLIST.base.map((d) => d.id).sort());
    const merger = parsed.overlays.merger ?? [];
    expect(merger.map((d) => d.id).sort()).toEqual((SEED_CHECKLIST.overlays.merger ?? []).map((d) => d.id).sort());
    expect(parsed.extractionFields.map((f) => f.id).sort()).toEqual(
      SEED_CHECKLIST.extractionFields.map((f) => f.id).sort()
    );
    const polis = parsed.base.find((d) => d.id === "asuransi.polis")!;
    expect(polis.expiryRule).toEqual({ kind: "fixed_years", years: 1 });
    expect(polis.importance).toBe("penting");
    const coc = parsed.extractionFields.find((f) => f.id === "change_of_control")!;
    expect(coc.type).toBe("verbatim");
    expect(coc.dealTriggerFor).toContain("akuisisi_saham");
  });

  it("parse throws on a workbook missing the Checklist sheet", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Random");
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseChecklistWorkbook(buf)).rejects.toThrow(/Checklist/);
  });
});

describe("resolveChecklist", () => {
  it("merges base + overlay for the transaction type + tailored docs", () => {
    const tailored = [{
      id: "perizinan.iup", aspectId: "perizinan" as const, label: "IUP", importance: "wajib" as const,
      keywords: ["iup"], source: "ai_tailored" as const,
    }];
    const r = resolveChecklist(SEED_CHECKLIST, "merger", tailored);
    const ids = r.expected.map((d) => d.id);
    expect(ids).toContain("perizinan.nib");                 // base
    expect(ids).toContain("perjanjian_penting.rancangan_merger"); // overlay
    expect(ids).toContain("perizinan.iup");                 // tailored
    expect(ids).not.toContain("permodalan_saham.persetujuan_coc"); // akuisisi_saham overlay
    expect(new Set(ids).size).toBe(ids.length);             // dedup by id
  });
});
