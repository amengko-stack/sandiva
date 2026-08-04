import { describe, it, expect } from "vitest";
import { fieldsForGroup, parseTableResponse } from "@/lib/dd/extract-table";
import { SEED_CHECKLIST } from "@/config/ddChecklist.seed";
import type { DDDocGroup } from "@/types/dd";

const group: DDDocGroup = { groupId: "e1-grp-0", label: "Perjanjian Kredit BCA", memberFiles: ["pk.pdf", "add1.pdf"] };
const fields = SEED_CHECKLIST.extractionFields;
const baseArgs = { group, entityId: "e1", fields, transactionType: "akuisisi_saham" as const };

describe("fieldsForGroup", () => {
  it("keeps universal fields and keyword-matched fields", () => {
    const f = fieldsForGroup(fields, "Perjanjian Kredit BCA");
    expect(f.map((x) => x.id)).toContain("change_of_control"); // universal
    expect(f.map((x) => x.id)).toContain("jaminan_agunan");    // matches "kredit"
  });
  it("drops keyword fields that do not match", () => {
    const f = fieldsForGroup(fields, "Perjanjian Sewa Gudang");
    expect(f.map((x) => x.id)).not.toContain("jaminan_agunan");
  });
});

describe("parseTableResponse", () => {
  it("maps cells, computes dealTriggered server-side, drops unknown fieldIds", () => {
    const raw = JSON.stringify({
      cells: [
        { fieldId: "change_of_control", value: "Perlu persetujuan tertulis bank", verbatim: "Debitur wajib memperoleh persetujuan tertulis...", sourceFile: "pk.pdf", found: true },
        { fieldId: "nilai", value: "Rp 50.000.000.000", verbatim: "fasilitas kredit sebesar Rp50.000.000.000", sourceFile: "pk.pdf", found: true },
        { fieldId: "tidak_dikenal", value: "x", verbatim: "", sourceFile: "pk.pdf", found: true },
        { fieldId: "non_compete", value: "[TIDAK DITEMUKAN]", verbatim: "", sourceFile: "", found: false },
      ],
    });
    const row = parseTableResponse(raw, null, baseArgs);
    expect(row.status).toBe("selesai");
    const ids = row.cells.map((c) => c.fieldId);
    expect(ids).not.toContain("tidak_dikenal");
    const coc = row.cells.find((c) => c.fieldId === "change_of_control")!;
    expect(coc.dealTriggered).toBe(true);   // found + dealTriggerFor includes akuisisi_saham
    const nilai = row.cells.find((c) => c.fieldId === "nilai")!;
    expect(nilai.dealTriggered).toBe(false); // no dealTriggerFor on nilai
    const nc = row.cells.find((c) => c.fieldId === "non_compete")!;
    expect(nc.dealTriggered).toBe(false);    // not found ⇒ never triggered
    expect(nc.value).toBe("—");
  });

  it("does not trigger for a transaction type outside dealTriggerFor", () => {
    const raw = JSON.stringify({
      cells: [{ fieldId: "change_of_control", value: "ada", verbatim: "kutipan", sourceFile: "pk.pdf", found: true }],
    });
    const row = parseTableResponse(raw, null, { ...baseArgs, transactionType: "likuidasi" });
    expect(row.cells[0].dealTriggered).toBe(false);
  });

  it("throws on garbage", () => {
    expect(() => parseTableResponse("html error page", null, baseArgs)).toThrow();
  });
});
