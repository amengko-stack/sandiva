import { describe, it, expect } from "vitest";
import { buildRedFlagPrompt, parseRedFlagResponse, promoteDealTriggeredCells } from "@/lib/dd/redflag";
import { extractTableSystem, redflagSystem } from "@/lib/dd/prompts";
import type { DDExtractionRow } from "@/types/dd";
import { DD_ASPECTS } from "@/config/ddAspects";

describe("parseRedFlagResponse", () => {
  it("parses findings and assigns ids", () => {
    const raw = JSON.stringify({ findings: [{
      severity: "kritis", anchor: "kutipan verbatim", sourceFile: "izin.pdf",
      problem: "Izin usaha kedaluwarsa", whyItMatters: "Operasi tanpa izin",
      suggestedFix: "Perpanjang izin", regulationRefs: ["PP 5/2021"],
    }]});
    const out = parseRedFlagResponse(raw, null, { entityId: "e1", aspectId: "perizinan" }).findings;
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("e1-risiko-perizinan-0");
    expect(out[0].dimension).toBe("risiko");
    expect(out[0].status).toBe("open");
    expect(out[0].verified).toBe(false);
  });
  it("coerces unknown severity to material and tolerates empty findings", () => {
    const raw = JSON.stringify({ findings: [{ severity: "wrong", anchor: "", problem: "p", whyItMatters: "w", suggestedFix: "s" }] });
    expect(parseRedFlagResponse(raw, null, { entityId: "e1", aspectId: "perkara" }).findings[0].severity).toBe("material");
    expect(parseRedFlagResponse('{"findings":[]}', null, { entityId: "e1", aspectId: "perkara" }).findings).toEqual([]);
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
    ).findings;
    expect(withField[0].legalConsequence).toContain("Pasal 32 ayat (1) UUWDP");

    const without = parseRedFlagResponse(
      JSON.stringify({ findings: [{ severity: "material", anchor: "q", problem: "p", whyItMatters: "w", suggestedFix: "s" }] }),
      null, { entityId: "e1", aspectId: "perizinan" }
    ).findings;
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

// The analysis chapters rendered as hollow scaffolding because Stage 5 produced
// only findings. The same call now also returns per-sub-section analysis.
describe("sub-section analysis", () => {
  const SUBS = ["Keabsahan Pendirian dan Anggaran Dasar", "Kepatuhan RUPS dan Kewenangan Organ Perseroan"];

  it("asks for analysis per named sub-section, with a worked quality bar", () => {
    const p = buildRedFlagPrompt({
      entityName: "PT Alpha", aspectId: "pendirian_ad", docsText: "x",
      transactionType: "akuisisi_saham", subsections: SUBS,
    });
    expect(p).toContain("SUB-BAGIAN ANALISIS YANG HARUS DIISI");
    expect(p).toContain("1. Keabsahan Pendirian dan Anggaran Dasar");
    expect(p).toContain("2. Kepatuhan RUPS dan Kewenangan Organ Perseroan");
    expect(p).toContain("bukan kalimat pengantar");
    expect(p).toContain('"analisis"');
    expect(p).toContain("Pasal 7 ayat (1) UUPT"); // the worked example
  });

  it("omits the analysis block when no sub-sections are supplied", () => {
    const p = buildRedFlagPrompt({
      entityName: "PT Alpha", aspectId: "pendirian_ad", docsText: "x", transactionType: "akuisisi_saham",
    });
    expect(p).not.toContain("SUB-BAGIAN ANALISIS YANG HARUS DIISI");
  });

  it("parses analyses, keeps the table, and routes findings to their sub-section", () => {
    const raw = JSON.stringify({
      findings: [{ severity: "material", anchor: "q", problem: "p", whyItMatters: "w", suggestedFix: "s", subsection: SUBS[1] }],
      analisis: [
        { subsection: SUBS[0], analysis: ["Pendirian sesuai Pasal 7 ayat (1) UUPT.", "Akta No. 8 disahkan."], verification: ["AD konsolidasi"] },
        { subsection: SUBS[1], analysis: ["Seluruh RUPS memenuhi kuorum."], verification: [], table: { headers: ["Tanggal", "Sah?"], rows: [["29 Jan 2019", "Ya"]] } },
      ],
    });
    const out = parseRedFlagResponse(raw, null, { entityId: "e1", aspectId: "pendirian_ad", subsections: SUBS });
    expect(out.analyses).toHaveLength(2);
    expect(out.analyses[0].analysis[0]).toContain("Pasal 7 ayat (1) UUPT");
    expect(out.analyses[0].verification).toEqual(["AD konsolidasi"]);
    expect(out.analyses[1].table?.headers).toEqual(["Tanggal", "Sah?"]);
    expect(out.findings[0].subsectionTitle).toBe(SUBS[1]);
  });

  // A misfiled analysis is worse than a missing one: it would appear under a
  // heading it does not answer.
  it("drops an analysis whose sub-section title is not one of those offered", () => {
    const raw = JSON.stringify({
      findings: [],
      analisis: [{ subsection: "Sub-bagian Yang Tidak Diminta", analysis: ["…"], verification: [] }],
    });
    const out = parseRedFlagResponse(raw, null, { entityId: "e1", aspectId: "pendirian_ad", subsections: SUBS });
    expect(out.analyses).toHaveLength(0);
  });

  it("drops an analysis with no prose, and tolerates a missing analisis key", () => {
    const empty = parseRedFlagResponse(
      JSON.stringify({ findings: [], analisis: [{ subsection: SUBS[0], analysis: [], verification: [] }] }),
      null, { entityId: "e1", aspectId: "pendirian_ad", subsections: SUBS }
    );
    expect(empty.analyses).toHaveLength(0);

    const absent = parseRedFlagResponse('{"findings":[]}', null, { entityId: "e1", aspectId: "pendirian_ad", subsections: SUBS });
    expect(absent.analyses).toEqual([]);
  });
});

// Live measurement: 20 of 32 anchors could not be found in the document they
// named, and the cause was not fabrication but presentation — the model wrote a
// labelled fact sheet ("Modal Dasar: Rp 50.000.000 (500 saham @ Rp 100.000)")
// where the deed says "modal dasar Perseroan sebesar Rp 50.000.000 (lima puluh
// juta Rupiah) terbagi atas 500 saham". "Kutipan verbatim" alone was already in
// the prompt and did not prevent it, so the rule now carries a wrong and a right
// example. Asserted here because a prompt instruction is the easiest thing in
// this codebase to drop by accident, and dropping this one silently returns the
// grounding check to a 60% false-alarm rate.
describe("verbatim anchor rule", () => {
  it("reaches both prompts that produce a checked quote", () => {
    // extractTableSystem's `verbatim` cells become finding anchors too.
    for (const prompt of [redflagSystem(), extractTableSystem()]) {
      expect(prompt).toContain("DISALIN KARAKTER DEMI KARAKTER");
      expect(prompt).toContain("SALAH:");
      expect(prompt).toContain("BENAR:");
      // The ellipsis convention the checker splits on must be the one taught.
      expect(prompt).toContain('" ... "');
      // Copying OCR damage verbatim rather than smoothing it. A DPS scan read
      // "Emili! Meilani" where the deed itself says ERNITA MEILANI five times;
      // the model silently repaired it to "Emilil Meilani", which would have put
      // a wrong notary in the report from a document the data room contradicts.
      expect(prompt).toContain("Emili!");
      expect(prompt).toContain("SALIN APA ADANYA");
    }
  });

  it("warns that a quote it cannot find is marked in the client report", () => {
    expect(redflagSystem()).toContain("[TIDAK TERVERIFIKASI TERHADAP DOKUMEN]");
  });
});
