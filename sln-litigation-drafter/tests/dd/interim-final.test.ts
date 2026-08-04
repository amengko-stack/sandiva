import { describe, it, expect } from "vitest";
import {
  finalReleaseBlocker, interimLegend, openingDocuments, openingQualifications,
  openingReliance, outstandingParagraphs, reportTitle,
} from "@/lib/dd/report-boilerplate";
import { chapterPendahuluan } from "@/lib/dd/report-chapters";
import type { DDEntity, DDRegime, DDReportMeta, DDTransaction } from "@/types/dd";

// Clients hand documents over in batches, and findings prompt requests for more,
// so a report is issued interim first and final once the data room closes. An
// interim report that does not say so — and does not say what is missing — invites
// the reader to treat provisional conclusions as settled ones.

const meta = (over: Partial<DDReportMeta> = {}): DDReportMeta => ({
  matterRef: "50160", clientName: "PT Klien", addressee: "Direksi PT Klien",
  relianceScope: "PT Klien dan penasihat keuangannya", clientRelease: true,
  ddStartDateISO: "2026-07-01", taxInScope: true, assumptionsVariant: "ringkas",
  reportStage: "final", signatoryName: "Advokat", signatoryTitle: "Partner",
  ...over,
});

const transaction: DDTransaction = {
  id: "t1", type: "akuisisi_saham", entities: [], cutoffDateISO: "2026-08-01",
} as unknown as DDTransaction;

describe("reportTitle", () => {
  it("says on the cover when the examination is unfinished", () => {
    expect(reportTitle("interim")).toContain("(INTERIM)");
    expect(reportTitle("final")).toBe("LAPORAN UJI TUNTAS DARI SEGI HUKUM");
    expect(reportTitle("final")).not.toContain("INTERIM");
  });

  it("has a legend saying the conclusions can change", () => {
    expect(interimLegend()).toContain("BELUM SELESAI");
    expect(interimLegend()).toContain("DAPAT BERUBAH");
  });
});

describe("outstandingParagraphs", () => {
  const three = ["Laporan keuangan auditan 2023", "Polis asuransi kebakaran", "Risalah RUPS 2024"];

  it("names the outstanding documents and counts them", () => {
    const out = outstandingParagraphs(meta({ reportStage: "interim" }), three);
    expect(out.join(" ")).toContain("terdapat 3 dokumen");
    for (const d of three) expect(out.join(" ")).toContain(d);
  });

  it("says the conclusions are provisional and how a change will be issued", () => {
    const text = outstandingParagraphs(meta({ reportStage: "interim" }), three).join(" ");
    expect(text).toContain("bersifat sementara");
    expect(text).toContain("supplement");
  });

  // Naming 60 documents in a paragraph makes it unreadable, but the count must
  // stay honest and the reader must be told where the rest are.
  it("caps the named list while keeping the true total", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Dokumen ${i + 1}`);
    const text = outstandingParagraphs(meta({ reportStage: "interim" }), many).join(" ");
    expect(text).toContain("terdapat 20 dokumen");
    expect(text).toContain("Dokumen 12");
    expect(text).not.toContain("Dokumen 13");
    expect(text).toContain("dan 8 dokumen lain");
  });

  it("still declares itself interim when nothing specific is outstanding", () => {
    const text = outstandingParagraphs(meta({ reportStage: "interim" }), []).join(" ");
    expect(text).toContain("bersifat interim");
    expect(text).toContain("dapat berubah");
  });

  it("says nothing at all in a final report", () => {
    expect(outstandingParagraphs(meta({ reportStage: "final" }), three)).toEqual([]);
    expect(outstandingParagraphs(undefined, three)).toEqual([]);
  });
});

describe("interim qualifications and reliance", () => {
  // The consequence is the part that protects the reader; "this is interim" alone
  // leaves them to work it out.
  it("refuses the uses that assume a closed examination", () => {
    const text = openingQualifications("interim").body.join(" ");
    expect(text).toContain("closing");
    expect(text).toContain("representations and warranties");
    expect(openingQualifications("final").body.join(" ")).not.toContain("closing");
  });

  it("narrows reliance to the client's internal use until the report is final", () => {
    const interim = openingReliance({ meta: meta({ reportStage: "interim" }) }).body.join(" ");
    expect(interim).toContain("penggunaan internal");
    expect(interim).toContain("baru berlaku atas laporan final");
    // The full clause is still there; the interim limit is added, not substituted.
    expect(interim).toContain("PT Klien dan penasihat keuangannya");
    expect(openingReliance({ meta: meta() }).body.join(" ")).not.toContain("penggunaan internal");
  });

  it("carries the outstanding documents into section B", () => {
    const body = openingDocuments({
      transaction, meta: meta({ reportStage: "interim" }), outstanding: ["Polis asuransi"],
    }).body.join(" ");
    expect(body).toContain("Polis asuransi");
    expect(openingDocuments({ transaction, meta: meta() }).body.join(" ")).not.toContain("interim");
  });
});

describe("chapterPendahuluan", () => {
  const entity = { id: "e1", name: "PT Target", listingStatus: "non_tbk" } as unknown as DDEntity;
  const regime = { layers: ["uupt"], capitalMarkets: false, parentTbkName: "" } as unknown as DDRegime;

  it("states what is outstanding right after the table of what was examined", () => {
    const contents = chapterPendahuluan({
      transaction, entity, regime, meta: meta({ reportStage: "interim" }),
      presentAspects: ["pendirian_ad"], docCategories: [],
      outstanding: ["Laporan keuangan auditan 2023"],
    });
    const docs = contents.find((c) => c.title === "Dokumen yang Diperiksa");
    expect(docs).toBeDefined();
    const text = (docs?.blocks ?? [])
      .map((b) => (b.kind === "para" ? b.text : ""))
      .join(" ");
    expect(text).toContain("Laporan keuangan auditan 2023");
    expect(text).toContain("bersifat interim");
  });

  it("leaves the chapter unchanged for a final report", () => {
    const contents = chapterPendahuluan({
      transaction, entity, regime, meta: meta(),
      presentAspects: ["pendirian_ad"], docCategories: [],
      outstanding: ["Laporan keuangan auditan 2023"],
    });
    const text = JSON.stringify(contents);
    expect(text).not.toContain("bersifat interim");
    expect(text).not.toContain("Laporan keuangan auditan 2023");
  });

  it("carries the interim limitation into the qualifications sub-section", () => {
    const contents = chapterPendahuluan({
      transaction, entity, regime, meta: meta({ reportStage: "interim" }),
      presentAspects: ["pendirian_ad"], docCategories: [],
    });
    expect(JSON.stringify(contents)).toContain("closing");
  });
});

describe("finalReleaseBlocker", () => {
  it("blocks a client release with nobody entitled to rely on it", () => {
    expect(finalReleaseBlocker(meta({ relianceScope: "  " }), 0)).toContain("Ruang Lingkup Keterandalan");
  });

  // The converse of that gate: the cover claims a closed examination while the
  // body reports documents that were asked for and never came.
  it("blocks a final release while documents are still outstanding", () => {
    const msg = finalReleaseBlocker(meta(), 4);
    expect(msg).toContain("4 dokumen");
    expect(msg).toContain("laporan interim");
    expect(msg).toContain("tidak berlaku (not applicable)");
  });

  it("allows a final release once nothing is outstanding", () => {
    expect(finalReleaseBlocker(meta(), 0)).toBe("");
  });

  // An interim report is supposed to go out with documents outstanding — that is
  // what it is for.
  it("allows an interim release with documents outstanding", () => {
    expect(finalReleaseBlocker(meta({ reportStage: "interim" }), 9)).toBe("");
  });

  it("does not gate an internal draft at all", () => {
    expect(finalReleaseBlocker(meta({ clientRelease: false, relianceScope: "" }), 9)).toBe("");
  });
});
