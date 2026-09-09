import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildDdReportDocx } from "@/lib/dd/dd-docx-builder";
import { verifyDocx } from "@/lib/docx-verify";
import { planChapters } from "@/config/ddChapters";
import { resolveRegime } from "@/lib/dd/regime";
import type { DDEntityResult, DDFinding, DDReportFormat, DDSubsectionAnalysis, DDTransaction } from "@/types/dd";

function documentXml(buf: Buffer): string {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Missing ZIP directory");
  let offset = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const nameLength = buf.readUInt16LE(offset + 28);
    const local = buf.readUInt32LE(offset + 42);
    if (buf.toString("utf8", offset + 46, offset + 46 + nameLength) === "word/document.xml") {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      return inflateRawSync(buf.subarray(start, start + buf.readUInt32LE(offset + 20))).toString("utf8");
    }
    offset += 46 + nameLength + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  throw new Error("Missing Word document");
}
const text = (xml: string) => xml.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const blocks = (xml: string) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:tbl[ >][\s\S]*?<\/w:tbl>/g) ?? [];
function subsection(xml: string, title: string): string {
  const all = blocks(xml);
  const start = all.findIndex(b => b.includes('w:val="Heading2"') && text(b).endsWith(title));
  expect(start, `Actual subsection ${title}`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < all.length && !/w:val="Heading[12]"/.test(all[end])) end++;
  return all.slice(start + 1, end).join("");
}
const findingRows = (xml: string, marker: string) => (xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []).filter(row => text(row).includes(marker));
const formats: DDReportFormat[] = ["pendahuluan_led", "exec_summary_led", "lut_pasar_modal", "findings_only"];
type Kind = "analisis_aspek" | "transaksi" | "transaksi_jual";

function fixture(format: DDReportFormat, kind: Kind) {
  const entity = { id: "rpt-entity-a", name: "PT Sintetis Alpha", role: "target" as const, dataRoomPath: "synthetic", files: [], listingStatus: "non_tbk" as const };
  const transaction: DDTransaction = { id: "rpt-synthetic", name: "Uji Sintetis", type: "akuisisi_saham", clientRole: kind === "transaksi_jual" ? "penjual" : "pembeli", cutoffDateISO: "2026-09-09", checklistVersion: "synthetic", entities: [entity], reportFormat: format };
  const plan = planChapters({ transactionType: transaction.type, regime: resolveRegime(entity), presentAspects: ["perizinan"], format, clientRole: transaction.clientRole });
  const chapter = plan.find(c => (c.kind === kind || (kind === "analisis_aspek" && c.kind === "kategori")) && (kind !== "analisis_aspek" || c.aspectIds.includes("perizinan")));
  if (!chapter) throw new Error(`Fixture has no ${kind} chapter in ${format}`);
  const sub = chapter.subs.find(s => !s.findings)!;
  const finding: DDFinding = { id: "rpt-finding", entityId: entity.id, aspectId: kind === "analisis_aspek" ? "perizinan" : null, subsectionTitle: sub.title, dimension: "risiko", severity: "material", anchor: "synthetic", sourceFile: "synthetic.pdf", problem: "RPT_DISTINCT_PROBLEM", whyItMatters: "synthetic", suggestedFix: "RPT_DISTINCT_REMEDY", verified: false, status: "open" };
  const result: DDEntityResult = { entity, classified: [], gaps: [], rows: [], findings: [finding], analyses: [], extractReport: null };
  const analysis: DDSubsectionAnalysis = { aspectId: kind === "analisis_aspek" ? "perizinan" : "transaksi", subsectionTitle: sub.title, analysis: ["RPT_ANALYSIS_PARAGRAPH"], table: { headers: ["RPT_TABLE_HEADER"], rows: [["RPT_TABLE_VALUE"]] }, citationIssues: ["SYNTHETIC_CITATION_ISSUE"], verification: ["RPT_VERIFY_ITEM"] };
  return { transaction, result, finding, analysis, chapter, title: sub.title };
}
async function build(f: ReturnType<typeof fixture>): Promise<string> {
  const buf = await buildDdReportDocx({ transaction: f.transaction, results: [f.result], consolidated: null });
  const validity = verifyDocx(buf);
  expect(validity.bad).toBe(0);
  expect(validity.illegal).toBe(0);
  return documentXml(buf);
}
const warning = (kind: Kind) => kind === "analisis_aspek" ? "belum dapat dianalisis" : kind === "transaksi" ? "[BELUM DIANALISIS]" : "Penjual wajib mengonfirmasi";

describe("LDD-RPT-01: findings survive absent subsection analysis", () => {
  for (const kind of ["analisis_aspek", "transaksi", "transaksi_jual"] as const) {
    it(`${kind}: keeps missing-analysis warning and detailed finding`, async () => {
      const f = fixture("pendahuluan_led", kind);
      const xml = await build(f);
      const section = subsection(xml, f.title);
      expect(text(section)).toContain(warning(kind));
      expect(findingRows(section, "RPT_DISTINCT_PROBLEM")).toHaveLength(1);
      expect(text(section)).toContain("RPT_DISTINCT_REMEDY");
      expect(findingRows(xml, "RPT_DISTINCT_PROBLEM")).toHaveLength(1);
      expect(text(section)).not.toContain("RPT_ANALYSIS_PARAGRAPH");
    });
    it(`${kind}: preserves analysis-present content and ordering`, async () => {
      const f = fixture("pendahuluan_led", kind);
      f.result.analyses = [f.analysis];
      const s = text(subsection(await build(f), f.title));
      const markers = ["RPT_ANALYSIS_PARAGRAPH", "RPT_TABLE_VALUE", "SYNTHETIC_CITATION_ISSUE", "RPT_DISTINCT_PROBLEM", "RPT_VERIFY_ITEM"];
      for (const m of markers) expect(s).toContain(m);
      for (let i = 1; i < markers.length; i++) expect(s.indexOf(markers[i])).toBeGreaterThan(s.indexOf(markers[i - 1]));
      expect(s).not.toContain(warning(kind));
    });
    it(`${kind}: another subsection analysis cannot hide a finding`, async () => {
      const f = fixture("pendahuluan_led", kind);
      f.result.analyses = [{ ...f.analysis, subsectionTitle: "RPT_OTHER_SUBSECTION" }];
      const s = subsection(await build(f), f.title);
      expect(text(s)).toContain(warning(kind));
      expect(findingRows(s, "RPT_DISTINCT_PROBLEM")).toHaveLength(1);
      expect(text(s)).not.toContain("RPT_ANALYSIS_PARAGRAPH");
    });
    it(`${kind}: retains eligibility, lawyer edits and existing warnings`, async () => {
      const f = fixture("pendahuluan_led", kind);
      f.result.findings = [
        { ...f.finding, status: "edited", editedProblem: "RPT_LAWYER_EDIT", grounding: { verdict: "not_found", coverage: 0, note: "synthetic" }, citationIssues: ["SYNTHETIC_ARTICLE"] },
        { ...f.finding, id: "supported", problem: "RPT_SUPPORTED", verification: { status: "supported", reason: "synthetic" } },
        { ...f.finding, id: "dismissed", problem: "RPT_DISMISSED", status: "dismissed" },
        ...(["refuted", "source_unresolved", "verification_failed"] as const).map(status => ({ ...f.finding, id: status, problem: `RPT_EXCLUDED_${status}`, verification: { status, reason: "synthetic" } })),
      ];
      const s = subsection(await build(f), f.title);
      expect(findingRows(s, "RPT_LAWYER_EDIT")).toHaveLength(1);
      expect(text(s)).toContain("[TIDAK TERVERIFIKASI TERHADAP DOKUMEN]");
      expect(text(s)).toContain("[PASAL TIDAK DITEMUKAN]");
      expect(text(s)).toContain("SYNTHETIC_ARTICLE");
      expect(findingRows(s, "RPT_SUPPORTED")).toHaveLength(1);
      expect(text(s)).not.toMatch(/RPT_DISTINCT_PROBLEM|RPT_DISMISSED|RPT_EXCLUDED_/);
    });
  }
  for (const format of formats) {
    it(`${format}: preserves real report format output`, async () => {
      const f = fixture(format === "findings_only" ? "pendahuluan_led" : format, "analisis_aspek");
      f.transaction.reportFormat = format;
      const plan = planChapters({ transactionType: f.transaction.type, regime: resolveRegime(f.result.entity), presentAspects: ["perizinan"], format, clientRole: f.transaction.clientRole });
      const title = format === "findings_only" ? plan.find(c => c.kind === "temuan" && c.aspectIds.includes("perizinan"))!.subs[0].title : f.title;
      const s = subsection(await build(f), title);
      expect(findingRows(s, "RPT_DISTINCT_PROBLEM")).toHaveLength(1);
      if (format !== "findings_only") expect(text(s)).toContain(warning("analisis_aspek"));
    });
  }
  for (const format of ["exec_summary_led", "lut_pasar_modal"] as const) {
    for (const kind of ["transaksi", "transaksi_jual"] as const) {
      it(`${format}/${kind}: keeps findings and the qualification together`, async () => {
        const f = fixture(format, kind);
        const s = subsection(await build(f), f.title);
        expect(findingRows(s, "RPT_DISTINCT_PROBLEM")).toHaveLength(1);
        expect(text(s)).toContain(warning(kind));
      });
    }
  }
  it("aspect closing table retains unmatched findings without duplicating mapped findings", async () => {
    const f = fixture("pendahuluan_led", "analisis_aspek");
    f.result.findings.push({ ...f.finding, id: "unknown", problem: "RPT_UNKNOWN_SUB", subsectionTitle: "Unplanned subsection" }, { ...f.finding, id: "no-sub", problem: "RPT_NO_SUB", subsectionTitle: undefined });
    const xml = await build(f);
    const close = subsection(xml, f.chapter.subs.find(s => s.findings)!.title);
    expect(findingRows(close, "RPT_UNKNOWN_SUB")).toHaveLength(1);
    expect(findingRows(close, "RPT_NO_SUB")).toHaveLength(1);
    expect(findingRows(close, "RPT_DISTINCT_PROBLEM")).toHaveLength(0);
    expect(findingRows(xml, "RPT_DISTINCT_PROBLEM")).toHaveLength(1);
  });
  it("does not broaden aspect membership or move another entity's finding into this subsection", async () => {
    const f = fixture("pendahuluan_led", "analisis_aspek");
    f.result.findings.push({ ...f.finding, id: "wrong-aspect", aspectId: "pendirian_ad", problem: "RPT_OTHER_ASPECT" });
    const other: DDEntityResult = { ...f.result, entity: { ...f.result.entity, id: "rpt-entity-b", name: "PT Sintetis Beta" }, findings: [{ ...f.finding, id: "other", entityId: "rpt-entity-b", problem: "RPT_OTHER_ENTITY" }] };
    f.transaction.entities.push(other.entity);
    const buf = await buildDdReportDocx({ transaction: f.transaction, results: [f.result, other], consolidated: null });
    expect(verifyDocx(buf).bad).toBe(0);
    const s = subsection(documentXml(buf), f.title);
    expect(findingRows(s, "RPT_DISTINCT_PROBLEM")).toHaveLength(1);
    expect(text(s)).not.toMatch(/RPT_OTHER_ASPECT|RPT_OTHER_ENTITY/);
  });
});
