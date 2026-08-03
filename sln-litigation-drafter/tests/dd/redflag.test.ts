import { describe, it, expect } from "vitest";
import { buildRedFlagPrompt, parseRedFlagResponse, promoteDealTriggeredCells } from "@/lib/dd/redflag";
import type { DDExtractionRow } from "@/types/dd";
import { DD_ASPECTS } from "@/config/ddAspects";

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

// A live run produced the legal consequence in 0 of 17 findings while it was
// only requested as prose inside whyItMatters. It is now a named JSON field, so
// these assert the field is actually demanded, grounded, and parsed.
describe("legalConsequence", () => {
  it("is requested in the JSON schema, with an aspect-specific grounding hint", () => {
    const p = buildRedFlagPrompt({
      entityName: "PT Alpha", aspectId: "perizinan", docsText: "x", transactionType: "akuisisi_saham",
    });
    expect(p).toContain('"legalConsequence"');
    expect(p).toContain("TIDAK BOLEH kosong");
    // Licensing sanctions are administrative and tiered — the hint must say so.
    expect(p).toContain("SANKSI ADMINISTRATIF");
    expect(p).toContain("PP 5/2021");
  });

  it("gives a different, correct hint for an aspect with no statutory sanction", () => {
    const p = buildRedFlagPrompt({
      entityName: "PT Alpha", aspectId: "pendirian_ad", docsText: "x", transactionType: "akuisisi_saham",
    });
    expect(p).toContain("TIDAK diancam sanksi pidana");
    expect(p).toContain("UUPT Pasal 97");
    expect(p).not.toContain("SANKSI ADMINISTRATIF");
  });

  it("covers every aspect, so no aspect falls through without a hint", () => {
    for (const a of DD_ASPECTS) {
      const p = buildRedFlagPrompt({
        entityName: "PT Alpha", aspectId: a.id, docsText: "x", transactionType: "akuisisi_saham",
      });
      expect(p, a.id).toContain("PETUNJUK KONSEKUENSI HUKUM UNTUK ASPEK INI: ");
      const hint = p.split("PETUNJUK KONSEKUENSI HUKUM UNTUK ASPEK INI: ")[1].split("\n")[0];
      expect(hint.length, a.id).toBeGreaterThan(40);
    }
  });

  it("is parsed when present and left undefined when the model omits it", () => {
    const withField = parseRedFlagResponse(
      JSON.stringify({ findings: [{ severity: "material", anchor: "q", problem: "p", whyItMatters: "w", suggestedFix: "s", legalConsequence: "Pasal 32 ayat (1) UUWDP: pidana kurungan 3 bulan" }] }),
      null, { entityId: "e1", aspectId: "perizinan" }
    );
    expect(withField[0].legalConsequence).toContain("Pasal 32 ayat (1) UUWDP");

    const without = parseRedFlagResponse(
      JSON.stringify({ findings: [{ severity: "material", anchor: "q", problem: "p", whyItMatters: "w", suggestedFix: "s" }] }),
      null, { entityId: "e1", aspectId: "perizinan" }
    );
    expect(without[0].legalConsequence).toBeUndefined();
  });

  it("sets the contractual consequence on deal-triggered clause findings without a model call", () => {
    const rows = [{
      groupId: "g1", entityId: "e1", agreementLabel: "PK BCA", memberFiles: ["pk.pdf"],
      status: "selesai" as const,
      cells: [{ fieldId: "change_of_control", type: "verbatim" as const, value: "perlu persetujuan", verbatim: "Debitur wajib...", sourceFile: "pk.pdf", dealTriggered: true }],
    }];
    const out = promoteDealTriggeredCells(rows, "e1");
    expect(out[0].legalConsequence).toContain("wanprestasi");
    expect(out[0].legalConsequence).toContain("KUHPerdata Pasal 1243");
  });
});

// A live run cited KUP penalty percentages (50%, 150%) that predate UU 7/2021
// (HPP), which amended those very provisions — the hint named only UU 28/2007,
// so the grounding itself was propagating stale tax law.
describe("tax sanction hint currency", () => {
  it("names the amending statute and forbids unverified penalty percentages", () => {
    const p = buildRedFlagPrompt({
      entityName: "PT Alpha", aspectId: "perpajakan", docsText: "x", transactionType: "akuisisi_saham",
    });
    expect(p).toContain("UU 7/2021");
    expect(p).toContain("JANGAN menyebutkan persentase sanksi tertentu");
    expect(p).toContain("PERLU VERIFIKASI");
  });
});
