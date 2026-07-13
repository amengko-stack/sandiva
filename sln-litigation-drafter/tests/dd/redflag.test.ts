import { describe, it, expect } from "vitest";
import { parseRedFlagResponse, promoteDealTriggeredCells } from "@/lib/dd/redflag";
import type { DDExtractionRow } from "@/types/dd";

describe("parseRedFlagResponse", () => {
  it("parses findings and assigns ids", () => {
    const raw = JSON.stringify({ findings: [{
      severity: "kritis", anchor: "kutipan verbatim", sourceFile: "izin.pdf",
      problem: "Izin usaha kedaluwarsa", whyItMatters: "Operasi tanpa izin",
      suggestedFix: "Perpanjang izin", regulationRefs: ["PP 5/2021"],
    }]});
    const out = parseRedFlagResponse(raw, null, { entityId: "e1", aspectId: "perizinan" });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("e1-risiko-perizinan-0");
    expect(out[0].dimension).toBe("risiko");
    expect(out[0].status).toBe("open");
    expect(out[0].verified).toBe(false);
  });
  it("coerces unknown severity to material and tolerates empty findings", () => {
    const raw = JSON.stringify({ findings: [{ severity: "wrong", anchor: "", problem: "p", whyItMatters: "w", suggestedFix: "s" }] });
    expect(parseRedFlagResponse(raw, null, { entityId: "e1", aspectId: "perkara" })[0].severity).toBe("material");
    expect(parseRedFlagResponse('{"findings":[]}', null, { entityId: "e1", aspectId: "perkara" })).toEqual([]);
  });
  it("throws on garbage", () => {
    expect(() => parseRedFlagResponse("oops", null, { entityId: "e1", aspectId: "perkara" })).toThrow();
  });
});

describe("promoteDealTriggeredCells", () => {
  const row: DDExtractionRow = {
    groupId: "e1-grp-0", entityId: "e1", agreementLabel: "PK BCA", memberFiles: ["pk.pdf"],
    status: "selesai",
    cells: [
      { fieldId: "change_of_control", type: "verbatim", value: "perlu persetujuan bank", verbatim: "Debitur wajib...", sourceFile: "pk.pdf", dealTriggered: true },
      { fieldId: "nilai", type: "currency", value: "Rp 50 M", verbatim: "", sourceFile: "pk.pdf", dealTriggered: false },
    ],
  };
  it("promotes only dealTriggered cells into risiko findings with the verbatim anchor", () => {
    const out = promoteDealTriggeredCells([row], "e1");
    expect(out).toHaveLength(1);
    expect(out[0].dimension).toBe("risiko");
    expect(out[0].anchor).toBe("Debitur wajib...");
    expect(out[0].sourceFile).toBe("pk.pdf");
    expect(out[0].aspectId).toBe("perjanjian_penting");
    expect(out[0].problem).toContain("PK BCA");
  });
});
