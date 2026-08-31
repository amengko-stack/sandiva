import { describe, it, expect } from "vitest";
import {
  buildRedFlagPrompt, parseRedFlagResponse, promoteDealTriggeredCells, selectAspectDocs,
} from "@/lib/dd/redflag";
import { extractTableSystem, redflagSystem } from "@/lib/dd/prompts";
import { seenDigest } from "@/lib/dd/analysis-state";
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
    // Content-derived, not positional: a re-run of the same issue must produce the
    // same id so the lawyer's review survives it. See tests/dd/review-state.test.ts.
    expect(out[0].id).toMatch(/^e1-risiko-perizinan-[0-9a-f]{12}$/);
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

// Three devices from the Polyprima acquisition report, the sample singled out for
// the completeness of its analysis. The difference from our output was never length
// — it was that each of its findings answered a question ours left hanging.
describe("analysis depth devices", () => {
  const p = () => redflagSystem();

  it("asks what the sanction does in practice, not only what it says", () => {
    expect(p()).toContain("KENYATAAN PENEGAKANNYA");
    expect(p()).toContain("dapat dibatalkan");
    // Practice must not be guessed: this is the same trap as the tax percentages.
    expect(p()).toContain("Jangan menerka praktik regulator");
  });

  // A circular shareholders' resolution is not a general meeting, and an article
  // about meetings may not reach it at all.
  it("asks for the rule to be tested against the mechanism actually used", () => {
    expect(p()).toContain("MEKANISME YANG BENAR-BENAR DIPAKAI");
    expect(p()).toContain("sirkuler");
    expect(p()).toContain("BUKAN RUPS");
  });

  it("asks how many are affected, of how many", () => {
    expect(p()).toContain("HITUNG PIHAK YANG TERKENA");
    expect(p()).toContain("11 dari 13");
    expect(p()).toContain("JANGAN memperkirakan");
  });

  // The devices are conditional on support in the documents. An unconditional
  // demand would produce invented enforcement practice and invented counts, which
  // is exactly what the rest of this prompt exists to prevent.
  it("makes every device conditional on what the documents support", () => {
    expect(p()).toContain("HANYA sepanjang didukung dokumen");
    expect(p()).toContain("[PERLU VERIFIKASI]");
  });
});

// SBN's tax aspect held six years of audited accounts. The corpus was cut at 40,000
// characters mid-way through the first, and the report then said the analysis was
// "terbatas pada dokumen yang tersedia di data room, yaitu Laporan Keuangan 2020" —
// telling the client their data room lacked five statements they had supplied. A
// pipeline limit reported as the client's failure is worse than no analysis.
describe("selecting documents for an aspect", () => {
  const doc = (fileName: string, size: number) => ({ fileName, text: "x".repeat(size) });

  it("keeps whole documents rather than cutting one in half", () => {
    const { docsText } = selectAspectDocs([doc("a.pdf", 300), doc("b.pdf", 300)], 1000);
    expect(docsText).toContain("=== a.pdf ===");
    expect(docsText).toContain("=== b.pdf ===");
    // Half a financial statement invites a conclusion drawn from a balance sheet
    // without its notes.
    expect((docsText.match(/x/g) ?? []).length).toBe(600);
  });

  it("names what did not fit instead of dropping it silently", () => {
    const { docsText, omitted } = selectAspectDocs(
      [doc("kecil.pdf", 100), doc("besar.pdf", 5000)],
      1000
    );
    expect(omitted).toEqual(["besar.pdf"]);
    expect(docsText).toContain("kecil.pdf");
    expect(docsText).not.toContain("besar.pdf");
  });

  // One enormous scan should not cost the report every licence behind it.
  it("packs smallest first so a single huge document cannot crowd out several", () => {
    const { omitted } = selectAspectDocs(
      [doc("raksasa.pdf", 9000), doc("a.pdf", 200), doc("b.pdf", 200), doc("c.pdf", 200)],
      1000
    );
    expect(omitted).toEqual(["raksasa.pdf"]);
  });

  it("always keeps at least one document, even past the cap", () => {
    const { docsText, omitted } = selectAspectDocs([doc("sendirian.pdf", 9000)], 100);
    expect(docsText).toContain("sendirian.pdf");
    expect(omitted).toEqual([]);
  });

  it("presents kept documents in data-room order, not size order", () => {
    const { docsText } = selectAspectDocs([doc("z.pdf", 300), doc("a.pdf", 100)], 5000);
    expect(docsText.indexOf("z.pdf")).toBeLessThan(docsText.indexOf("a.pdf"));
  });

  it("omits nothing when everything fits", () => {
    expect(selectAspectDocs([doc("a.pdf", 10), doc("b.pdf", 10)]).omitted).toEqual([]);
  });
});

describe("the prompt says what it was not shown", () => {
  const withOmitted = (omittedDocs: string[]) =>
    buildRedFlagPrompt({
      entityName: "PT Alpha", aspectId: "perpajakan", docsText: "isi",
      transactionType: "likuidasi", omittedDocs,
    });

  // The distinction the report turns on: "not supplied" and "not shown to me" call
  // for opposite sentences to the client.
  it("names the omitted documents and forbids calling them unavailable", () => {
    const p = withOmitted(["FS 2021.pdf", "FS 2022.pdf"]);
    expect(p).toContain("FS 2021.pdf; FS 2022.pdf");
    expect(p).toContain("JANGAN menyatakan dokumen tersebut tidak tersedia");
    expect(p).toContain("[PERLU VERIFIKASI]");
  });

  it("says nothing when nothing was omitted", () => {
    expect(withOmitted([])).not.toContain("TIDAK DISERTAKAN");
  });
});

// Naming the omissions showed the packing rule was wrong. Across one real matter,
// smallest-first cost the licensing chapter its NIB, the insurance chapter both
// policies, and the tax chapter five financial statements and the tax return. Size is
// a packing constraint; it says nothing about what a chapter is about.
describe("what a chapter is about goes in first", () => {
  const doc = (fileName: string, size: number, answersChecklistItem = false) => ({
    fileName, text: "x".repeat(size), answersChecklistItem,
  });

  it("keeps a large checklist document over several small unmatched ones", () => {
    const { docsText, omitted } = selectAspectDocs(
      [doc("kecil-1.pdf", 400), doc("kecil-2.pdf", 400), doc("NIB.pdf", 700, true)],
      1000
    );
    expect(docsText).toContain("NIB.pdf");
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted).not.toContain("NIB.pdf");
  });

  it("still packs smallest first among documents of equal standing", () => {
    const { omitted } = selectAspectDocs(
      [doc("raksasa.pdf", 9000), doc("a.pdf", 200), doc("b.pdf", 200)],
      1000
    );
    expect(omitted).toEqual(["raksasa.pdf"]);
  });

  it("omits a checklist document only when even it cannot fit alongside another", () => {
    const { docsText } = selectAspectDocs(
      [doc("besar.pdf", 900, true), doc("juga-besar.pdf", 900, true)],
      1000
    );
    expect(docsText).toContain("besar.pdf");
  });

  it("behaves as before when nothing answers a checklist item", () => {
    const { omitted } = selectAspectDocs([doc("a.pdf", 200), doc("b.pdf", 9000)], 1000);
    expect(omitted).toEqual(["b.pdf"]);
  });
});

// The table said "supplied but unreadable" while the prose next to it still said the
// document had never been handed over. A scan is never offered to the model at all,
// so unless it is told, it reports an absence — and the prose is the half a client
// actually reads.
describe("scans the model was never shown", () => {
  const args = {
    entityName: "PT Target",
    aspectId: "pendirian_ad" as const,
    docsText: "=== a.pdf ===\nisi",
    transactionType: "likuidasi" as const,
  };

  it("names them and forbids calling them missing", () => {
    const p = buildRedFlagPrompt({ ...args, unreadableDocs: ["Akta Pendirian 1998 (pindaian).pdf"] });
    expect(p).toContain("Akta Pendirian 1998 (pindaian).pdf");
    expect(p).toContain("DOKUMEN ITU ADA");
    expect(p).toContain("JANGAN menyatakan dokumen tersebut tidak diserahkan");
    expect(p).toContain("[PERLU VERIFIKASI]");
  });

  it("distinguishes the reason from a size-capped omission", () => {
    const p = buildRedFlagPrompt({
      ...args,
      omittedDocs: ["besar.pdf"],
      unreadableDocs: ["pindaian.pdf"],
    });
    expect(p).toContain("karena batas ukuran");
    expect(p).toContain("pindaian tanpa lapisan teks");
    // Both blocks survive together; neither replaces the other.
    expect(p).toContain("besar.pdf");
    expect(p).toContain("pindaian.pdf");
  });

  it("says nothing when every document could be read", () => {
    expect(buildRedFlagPrompt(args)).not.toContain("pindaian tanpa lapisan teks");
  });

  it("names failed extractions and forbids treating them as not supplied", () => {
    const p = buildRedFlagPrompt({ ...args, failedDocs: ["Akta Pendirian gagal.pdf"] });
    expect(p).toContain("Akta Pendirian gagal.pdf");
    expect(p).toContain("gagal diekstrak");
    expect(p).toContain("DOKUMEN ITU ADA");
    expect(p).toContain("JANGAN menyatakan dokumen tersebut tidak diserahkan");
  });
});

// Fourth cache in this codebase whose key risked describing part of the request and
// missing the part that had just changed.
describe("seenDigest covers what the model is told it cannot see", () => {
  it("changes when the unreadable list changes", () => {
    const a = seenDigest("teks", [], ["scan.pdf"]);
    const b = seenDigest("teks", [], []);
    expect(a).not.toBe(b);
  });

  it("is unchanged for callers that pass no list", () => {
    expect(seenDigest("teks", ["x.pdf"])).toBe(seenDigest("teks", ["x.pdf"], []));
  });

  it("changes when a failed-document list changes", () => {
    expect(seenDigest("teks", [], [], ["gagal.pdf"]))
      .not.toBe(seenDigest("teks", [], [], []));
  });
});
