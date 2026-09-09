import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { buildDdReportDocx } from "@/lib/dd/dd-docx-builder";
import { verifyDocx } from "@/lib/docx-verify";
import type { DDConsolidated, DDEntityResult, DDFinding, DDReportFormat, DDTransaction } from "@/types/dd";

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

const text = (xml: string) => xml.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '\"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
function chapters(xml: string): string[] {
  const blocks = xml.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:tbl[ >][\s\S]*?<\/w:tbl>/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i].includes('w:val="Heading1"') || !text(blocks[i]).includes("REKOMENDASI DAN TINDAK LANJUT")) continue;
    let end = i + 1;
    while (end < blocks.length && !blocks[end].includes('w:val="Heading1"') && !text(blocks[end]).startsWith("ENTITAS:")) end++;
    out.push(blocks.slice(i + 1, end).join(""));
  }
  return out;
}
const rows = (s: string) => (s.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []).map(r => (r.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g) ?? []).map(text));
function entity(id: string, findings: DDFinding[] = []): DDEntityResult {
  return { entity: { id, name: `PT Sintetis ${id}`, role: "target", files: [], dataRoomPath: "synthetic", listingStatus: "non_tbk" }, classified: [], gaps: [], rows: [], findings, analyses: [], extractReport: null };
}
function finding(entityId: string, id: string, patch: Partial<DDFinding> = {}): DDFinding {
  return { entityId, id, aspectId: "perizinan", dimension: "risiko", severity: "material", anchor: "", sourceFile: null, problem: `PROBLEM_${id}`, whyItMatters: "synthetic", suggestedFix: `FIX_${id}`, verified: false, status: "open", ...patch };
}
async function build(results: DDEntityResult[], format: DDReportFormat = "findings_only", clientRole = "pembeli", consolidated: DDConsolidated | null = null) {
  const transaction: DDTransaction = { id: "rpt02-synthetic", name: "Synthetic RPT02", type: "akuisisi_saham", clientRole, cutoffDateISO: "2026-09-09", checklistVersion: "synthetic", entities: results.map(r => r.entity), reportFormat: format };
  const before = JSON.stringify({ results, transaction, consolidated });
  const buf = await buildDdReportDocx({ transaction, results, consolidated });
  expect(verifyDocx(buf).bad).toBe(0);
  expect(verifyDocx(buf).illegal).toBe(0);
  expect(JSON.stringify({ results, transaction, consolidated })).toBe(before);
  return documentXml(buf);
}

describe("LDD-RPT-02 recommendation attribution", () => {
  for (const role of ["pembeli", "penjual"]) {
    it(`${role}: keeps recommendations inside their own entity chapter`, async () => {
      const xml = await build([entity("alpha", [finding("alpha", "A")]), entity("beta", [finding("beta", "B")])], "findings_only", role);
      const ss = chapters(xml); expect(ss).toHaveLength(2);
      expect(rows(ss[0])).toEqual([["No.", "Hal", "Rekomendasi"], ["1", "PROBLEM_A", "FIX_A"]]);
      expect(rows(ss[1])).toEqual([["No.", "Hal", "Rekomendasi"], ["1", "PROBLEM_B", "FIX_B"]]);
      expect(text(xml)).toContain("ENTITAS: PT SINTETIS ALPHA");
      expect(text(xml)).toContain("ENTITAS: PT SINTETIS BETA");
    });
    it(`${role}: preserves same remedy across entities without moving problems`, async () => {
      const ss = chapters(await build([entity("alpha", [finding("alpha", "A", { suggestedFix: "SHARED" })]), entity("beta", [finding("beta", "B", { suggestedFix: "SHARED" })])], "findings_only", role));
      expect(rows(ss[0]).slice(1)).toEqual([["1", "PROBLEM_A", "SHARED"]]);
      expect(rows(ss[1]).slice(1)).toEqual([["1", "PROBLEM_B", "SHARED"]]);
    });
  }
  it("retains distinct findings with identical remedies and identical visible wording", async () => {
    const ss = chapters(await build([entity("alpha", [finding("alpha", "A", { suggestedFix: "SHARED" }), finding("alpha", "B", { suggestedFix: "SHARED" }), finding("alpha", "C", { problem: "PROBLEM_B", suggestedFix: "SHARED" })])]));
    expect(rows(ss[0]).slice(1)).toEqual([["1", "PROBLEM_A", "SHARED"], ["2", "PROBLEM_B", "SHARED"], ["3", "PROBLEM_B", "SHARED"]]);
  });
  it("preserves actual eligibility and nullish lawyer edits", async () => {
    const fs = [finding("alpha", "open"), finding("alpha", "supported", { verification: { status: "supported", reason: "synthetic" } }), finding("alpha", "edited", { status: "edited", editedProblem: "LAWYER_TEXT" }), finding("alpha", "empty", { status: "edited", editedProblem: "" }), finding("alpha", "dismissed", { status: "dismissed" }), ...(["refuted", "source_unresolved", "verification_failed"] as const).map(status => finding("alpha", status, { verification: { status, reason: "synthetic" } }))];
    const rr = rows(chapters(await build([entity("alpha", fs)]))[0]).slice(1);
    expect(rr).toEqual([["1", "PROBLEM_open", "FIX_open"], ["2", "PROBLEM_supported", "FIX_supported"], ["3", "LAWYER_TEXT", "FIX_edited"], ["4", "", "FIX_empty"]]);
  });
  it("counts retained marked rows once and never borrows another entity warning", async () => {
    const a = entity("alpha", [finding("alpha", "plain", { suggestedFix: "SAME" }), finding("alpha", "later", { problem: "[DOKUMEN TIDAK TERSEDIA] LATER", suggestedFix: "SAME" }), finding("alpha", "both", { problem: "[PERLU VERIFIKASI] BOTH", suggestedFix: "[DOKUMEN TIDAK TERSEDIA] FIX" }), finding("alpha", "edit", { editedProblem: "[PERLU VERIFIKASI] EDIT", suggestedFix: "SAME" }), finding("alpha", "fixmark", { suggestedFix: "[PERLU VERIFIKASI] REMEDY" })]);
    const ss = chapters(await build([a, entity("beta", [finding("beta", "plain")])]));
    expect(rows(ss[0])).toHaveLength(6);
    expect(text(ss[0])).toContain("Sejumlah 4 dari 5 rekomendasi");
    expect(text(ss[1])).toContain("Tidak terdapat rekomendasi di atas yang bergantung");
    expect(text(ss[1])).not.toContain("LATER");
  });
  it("removes an old marker when effective lawyer text replaces it", async () => {
    const ss = chapters(await build([entity("alpha", [finding("alpha", "edit", { problem: "[PERLU VERIFIKASI] OLD", editedProblem: "CLEARED" })])]));
    expect(text(ss[0])).toContain("Tidak terdapat rekomendasi di atas yang bergantung");
    expect(rows(ss[0])[1][1]).toBe("CLEARED");
  });
  it("keeps an empty entity empty beside a populated entity", async () => {
    const ss = chapters(await build([entity("alpha", [finding("alpha", "dismissed", { status: "dismissed" })]), entity("beta", [finding("beta", "B")])]));
    expect(rows(ss[0])).toHaveLength(0);
    expect(text(ss[0])).toContain("Tidak terdapat rekomendasi tindak lanjut yang timbul dari uji tuntas ini.");
    expect(text(ss[0])).not.toContain("PROBLEM_B");
    expect(rows(ss[1]).slice(1)).toEqual([["1", "PROBLEM_B", "FIX_B"]]);
  });
  it("supports a completely empty single-entity report", async () => {
    const ss = chapters(await build([entity("alpha")])); expect(ss).toHaveLength(1);
    expect(rows(ss[0])).toHaveLength(0); expect(text(ss[0])).toContain("Tidak terdapat rekomendasi tindak lanjut");
  });
  it("escapes XML-sensitive recommendation strings", async () => {
    const ss = chapters(await build([entity("alpha", [finding("alpha", "escape", { problem: "A < B & C > D", suggestedFix: "X & Y < Z" })])]));
    expect(rows(ss[0])[1]).toEqual(["1", "A < B & C > D", "X & Y < Z"]);
  });
  for (const format of ["pendahuluan_led", "exec_summary_led", "lut_pasar_modal"] as const) {
    it(`${format}: does not add a findings-only recommendation chapter`, async () => {
      const xml = await build([entity("alpha", [finding("alpha", "A")])], format);
      expect(chapters(xml)).toHaveLength(0); expect(text(xml)).toContain("PROBLEM_A");
    });
  }
  it("keeps consolidated findings in their separate section", async () => {
    const consolidated: DDConsolidated = { transactionType: "akuisisi_saham", crossEntityFindings: [finding("consolidated", "CROSS")], aspectRollup: [], generatedAt: "2026-09-09T00:00:00Z" };
    const xml = await build([entity("alpha", [finding("alpha", "A")]), entity("beta", [finding("beta", "B")])], "findings_only", "pembeli", consolidated);
    for (const s of chapters(xml)) expect(text(s)).not.toContain("PROBLEM_CROSS");
    expect(text(xml)).toContain("TEMUAN LINTAS-ENTITAS"); expect(text(xml)).toContain("PROBLEM_CROSS");
  });
});
