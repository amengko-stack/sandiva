import { describe, it, expect } from "vitest";
import { renderSupplementSections } from "@/lib/dd/supplement-render";
import { buildSupplementDocx } from "@/lib/dd/dd-docx-builder";
import { verifyDocx } from "@/lib/docx-verify";
import type {
  DDEntity, DDFinding, DDReportMeta, DDSupplementDiff, DDTransaction,
} from "@/types/dd";

const finding = (over: Partial<DDFinding> = {}): DDFinding => ({
  id: "f1", entityId: "e1", aspectId: "perizinan", dimension: "risiko",
  severity: "material", anchor: "a", sourceFile: "nib.pdf",
  problem: "NIB belum diperbarui", whyItMatters: "w", suggestedFix: "Perbarui NIB",
  verified: false, status: "open",
  ...over,
});

const diff = (over: Partial<DDSupplementDiff> = {}): DDSupplementDiff => ({
  baselineIssuedAtISO: "2026-08-01T00:00:00.000Z",
  baselineCutoffDateISO: "2026-07-31",
  cutoffDateISO: "2026-09-15",
  newDocuments: ["fs2023.pdf"],
  documentsExaminedNow: 5,
  gapsClosed: ["Laporan keuangan auditan 2023"],
  gapsNoLongerListed: [],
  gapsFirstListedNow: [],
  gapsStillOutstanding: ["Polis asuransi kebakaran"],
  findingsFromNewDocuments: [],
  findingsNoLongerRaised: [],
  findingsDismissedSinceBaseline: [],
  findingsCarriedForward: 3,
  ...over,
});

const text = (d: DDSupplementDiff) =>
  JSON.stringify(renderSupplementSections(d));

describe("renderSupplementSections", () => {
  it("reports the documents this examination read and the earlier one did not", () => {
    const t = text(diff());
    expect(t).toContain("fs2023.pdf");
    expect(t).toContain("31 Juli 2026");
  });

  it("says plainly when there is nothing in a section rather than omitting it", () => {
    const t = text(diff({ gapsClosed: [], gapsStillOutstanding: [] }));
    expect(t).toContain("Tidak ada.");
  });

  // An item that left the outstanding list without being supplied must never sit
  // under the same heading as one that was supplied: that would assert receipt of a
  // document nobody has seen.
  it("keeps not-supplied departures out of the supplied section's list", () => {
    const sections = renderSupplementSections(
      diff({ gapsClosed: ["Laporan keuangan auditan 2023"], gapsNoLongerListed: ["Polis lama"] })
    );
    const supplied = sections.find((s) => s.title === "Dokumen Yang Telah Dilengkapi");
    const listed = (supplied?.blocks ?? []).filter((b) => b.kind === "list");
    expect(JSON.stringify(listed[0])).toContain("Laporan keuangan auditan 2023");
    expect(JSON.stringify(listed[0])).not.toContain("Polis lama");
    expect(JSON.stringify(supplied)).toContain("BUKAN karena telah");
  });

  // The baseline records no provenance for a checklist item, so the supplement must
  // not say the new documents caused it to be listed.
  it("makes no causal claim about a requirement listed for the first time", () => {
    const t = text(diff({ gapsFirstListedNow: ["Risalah rapat Direksi"] }));
    expect(t).toContain("Risalah rapat Direksi");
    expect(t).toContain("tidak menyatakan apa yang menyebabkannya tercatat");
  });

  it("tabulates the findings that arise from the additional documents", () => {
    const t = text(diff({ findingsFromNewDocuments: [finding()] }));
    expect(t).toContain("NIB belum diperbarui");
    expect(t).toContain("Perbarui NIB");
  });

  it("says so when the additional documents raise nothing", () => {
    expect(text(diff())).toContain("tidak menghasilkan temuan baru");
  });

  // The most important sentence in the document: only a lawyer can conclude that an
  // earlier finding no longer stands.
  it("refuses to present an unraised finding as cured", () => {
    const t = text(
      diff({
        findingsNoLongerRaised: [
          { id: "f9", aspectId: "perizinan", sourceFile: "nib.pdf", severity: "kritis", problem: "Izin kedaluwarsa", status: "open" },
        ],
      })
    );
    expect(t).toContain("Izin kedaluwarsa");
    expect(t).toContain("BUKAN");
    expect(t).toContain("telah teratasi");
    expect(t).toContain("telaah advokat");
  });

  it("accounts separately for what the lawyer dismissed after the earlier report", () => {
    const t = text(
      diff({
        findingsDismissedSinceBaseline: [
          { id: "f8", aspectId: "perizinan", sourceFile: "nib.pdf", severity: "minor", problem: "Hal yang dikesampingkan", status: "open" },
        ],
      })
    );
    expect(t).toContain("Hal yang dikesampingkan");
    expect(t).toContain("dikesampingkan berdasarkan telaah");
  });

  it("states how many findings continue unchanged", () => {
    expect(text(diff())).toContain("3 temuan");
  });
});

describe("buildSupplementDocx", () => {
  const meta: DDReportMeta = {
    matterRef: "50160", clientName: "PT Klien", addressee: "Direksi",
    relianceScope: "PT Klien", clientRelease: true, ddStartDateISO: "2026-07-01",
    taxInScope: true, assumptionsVariant: "ringkas", reportStage: "interim",
    signatoryName: "Advokat", signatoryTitle: "Partner",
  };
  const transaction = {
    id: "t1", name: "Proyek Alpha", type: "akuisisi_saham", entities: [],
    cutoffDateISO: "2026-09-15", clientRole: "pembeli", reportMeta: meta,
  } as unknown as DDTransaction;
  const entity = { id: "e1", name: "PT Target", listingStatus: "non_tbk" } as unknown as DDEntity;

  it("produces a Word file that passes the integrity gate", async () => {
    const buf = await buildSupplementDocx({ transaction, entity, diff: diff() });
    const verdict = verifyDocx(buf);
    expect(verdict.bad).toBe(0);
    expect(verdict.illegal).toBe(0);
    expect(buf.length).toBeGreaterThan(5000);
  });

  // A supplement with nothing in it would say nothing while presenting itself as an
  // addition to a report the client relies on.
  it("refuses to build when there is nothing to report", async () => {
    const empty = diff({
      newDocuments: [], gapsClosed: [], gapsNoLongerListed: [], gapsFirstListedNow: [],
      findingsFromNewDocuments: [], findingsNoLongerRaised: [], findingsDismissedSinceBaseline: [],
    });
    await expect(buildSupplementDocx({ transaction, entity, diff: empty })).rejects.toThrow(
      /tidak dapat diterbitkan/
    );
  });

  it("refuses a client release with nobody entitled to rely on it", async () => {
    const txn = {
      ...transaction,
      reportMeta: { ...meta, relianceScope: "  " },
    } as unknown as DDTransaction;
    await expect(buildSupplementDocx({ transaction: txn, entity, diff: diff() })).rejects.toThrow(
      /Ruang Lingkup Keterandalan/
    );
  });

  it("builds an internal draft without a reliance scope", async () => {
    const txn = {
      ...transaction,
      reportMeta: { ...meta, clientRelease: false, relianceScope: "" },
    } as unknown as DDTransaction;
    const buf = await buildSupplementDocx({ transaction: txn, entity, diff: diff() });
    expect(verifyDocx(buf).bad).toBe(0);
  });
});
