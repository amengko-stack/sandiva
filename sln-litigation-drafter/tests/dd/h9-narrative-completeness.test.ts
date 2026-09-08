import { beforeEach, describe, expect, it, vi } from "vitest";
import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { extractNarrativeSectionI, parseNarrativeResponse } from "@/lib/dd/narrative";
import { coverageNotes, emptyNarrative, parseNarrativeCoverage, prepareNarrativeInput, reconcileNarrative, type NarrativeInput } from "@/lib/dd/narrative-coverage";
import { renderNarrativeSectionI } from "@/lib/dd/narrative-render";
import { ddKeys } from "@/lib/dd/blob-keys";
import type { DDClassifiedDoc, DDNarrativeSectionI, DDReportFormat, DDTransaction } from "@/types/dd";
import type { NarrativeNotice } from "@/components/dd/DDStage5Review";

// The application's Vitest config preserves JSX for Next.js. Compile the actual
// caller module with the installed TypeScript compiler, then execute its real
// stream consumer and notice component. Unused surrounding UI imports cannot run.
const uiExports: Record<string, unknown> = {};
const uiCode = ts.transpileModule(readFileSync("components/dd/DDStage5Review.tsx", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
new Function("require", "exports", uiCode)((name: string) => {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return jsxRuntime;
  if (name === "@/context/DDContext") return { useDD: () => { throw new Error("Context not part of notice test"); } };
  if (name === "@/components/dd/DDSourcePreview") return { default: () => null };
  if (name === "@/config/ddAspects") return { aspectLabel: () => "synthetic" };
  throw new Error(`Unexpected UI import: ${name}`);
}, uiExports);
const { consumeNarrativeStream, NarrativeCoverageNotice, narrativeNoticeFromResponse } = uiExports as typeof import("@/components/dd/DDStage5Review");

const fake = vi.hoisted(() => ({ blobs: new Map<string, string>(), create: vi.fn(), read: vi.fn(), write: vi.fn(), construct: vi.fn() }));
vi.mock("@/lib/blob", async (original) => ({
  ...await original<typeof import("@/lib/blob")>(),
  readBlobText: fake.read, writeBlobText: fake.write,
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {
  constructor() { fake.construct(); }
  messages = { create: fake.create };
} }));
import { GET, POST } from "@/app/api/dd/narrative/route";
import { loadEntityResults } from "@/lib/dd/load-results";
import { buildDdReportDocx } from "@/lib/dd/dd-docx-builder";

const SID = "h9_synthetic_session";
const classification = (fileName = "a", aspectId: DDClassifiedDoc["aspectId"] = "pendirian_ad"): DDClassifiedDoc => ({
  fileName, entityId: "e1", aspectId, expectedDocId: "pendirian_ad.akta", docLabel: "Akta sintetik",
  docDate: null, parties: [], summary: "Sintetik", confidence: "tinggi", reasoning: "fixture",
});
const report = (files: { name: string; status: unknown }[] = [{ name: "a", status: "selesai" }]) => ({
  sessionId: SID, folderPath: "synthetic", docTypeId: "dd", practiceAreaId: null, claimType: null,
  ref: "synthetic", timestamp: "2026-09-08T00:00:00.000Z", files: files.map((f) => ({
    category: "akta", documentType: "akta", extractionMode: "text", ...f,
  })), totalChars: 10, processed: files.length, skipped: 0,
});
const input = (text = "Dokumen sintetik."): NarrativeInput => ({
  entityId: "e1", entityName: "PT Sintetik", classified: [classification()],
  contentByFile: new Map([["a", text]]), extractReport: report(),
});
const generated = (over: Record<string, unknown> = {}) => JSON.stringify({ ...emptyNarrative("e1", "2026-09-08T00:00:00.000Z"), ...over });
const response = (stop = "end_turn", text = generated()) => ({ stop_reason: stop, content: [{ type: "text", text }] });
const client = { messages: { create: fake.create } } as unknown as Anthropic;
const run = (args: NarrativeInput) => extractNarrativeSectionI(client, { ...args, classified: args.classified as DDClassifiedDoc[] });
const txn: DDTransaction = {
  id: SID, name: "Proyek Sintetik", type: "akuisisi_saham", clientRole: "pembeli", cutoffDateISO: "2026-09-08", checklistVersion: "seed-1",
  entities: [{ id: "e1", name: "PT Sintetik", role: "target", dataRoomPath: "synthetic", files: [] }],
};
const block = (name: string, text: string) => `=== ${name} ===\n[Metadata: kategori=akta; metode=text]\n${text}\n\n`;
function seed(args = input()) {
  fake.blobs.set(ddKeys.transaction(SID), JSON.stringify(txn));
  fake.blobs.set(ddKeys.classified(SID, "e1"), JSON.stringify(args.classified));
  fake.blobs.set(ddKeys.extracted(SID, "e1"), Array.from(args.contentByFile).map(([n, t]) => block(n, t)).join(""));
  if (args.extractReport !== undefined) fake.blobs.set(ddKeys.report(SID, "e1"), JSON.stringify(args.extractReport));
}
async function request(body: unknown = { sessionId: SID, entityId: "e1" }) {
  const res = await POST(new NextRequest("http://localhost/api/dd/narrative", { method: "POST", body: JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, text, messages: res.status === 200 ? text.trim().split("\n").map((l) => JSON.parse(l)) : [] };
}
const textBlocks = (n: DDNarrativeSectionI) => JSON.stringify(renderNarrativeSectionI(n, "PT Sintetik"));
function wordText(buf: Buffer) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("ZIP directory missing");
  let off = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const length = buf.readUInt16LE(off + 28), extra = buf.readUInt16LE(off + 30), comment = buf.readUInt16LE(off + 32);
    if (buf.toString("utf8", off + 46, off + 46 + length) === "word/document.xml") {
      const local = buf.readUInt32LE(off + 42), size = buf.readUInt32LE(off + 20);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      return inflateRawSync(buf.subarray(start, start + size)).toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    }
    off += 46 + length + extra + comment;
  }
  throw new Error("Word document missing");
}

beforeEach(() => {
  vi.clearAllMocks(); fake.blobs.clear();
  fake.read.mockImplementation(async (key: string) => fake.blobs.get(key) ?? null);
  fake.write.mockImplementation(async (key: string, value: string) => { fake.blobs.set(key, value); });
  fake.create.mockResolvedValue(response());
});

describe("H-9 frozen fixture map: deterministic input and completion", () => {
  it("F01: zero, one and multiple files have exact body/header accounting", () => {
    const zero = prepareNarrativeInput({ ...input(), classified: [], contentByFile: new Map(), extractReport: report([]) });
    expect(zero.coverage.includedChars).toBe(0);
    expect(prepareNarrativeInput(input("ABC")).docsText).toBe("=== a ===\nABC");
    const multi = prepareNarrativeInput({ ...input("ABC"), classified: [classification(), classification("b")], contentByFile: new Map([["a", "ABC"], ["b", "DE"]]), extractReport: report([{ name: "a", status: "selesai" }, { name: "b", status: "selesai" }]) });
    expect(multi.docsText).toBe("=== a ===\nABC\n\n=== b ===\nDE");
    expect(multi.coverage).toMatchObject({ includedChars: 5, availableChars: 5, status: "full_supplied_input", promptSourceChars: 27 });
  });
  it("F02: exactly 100000 source characters remain fully supplied", async () => {
    const n = await run(input("A".repeat(99990)));
    expect(n.coverage).toMatchObject({ promptSourceChars: 100000, status: "full_supplied_input", includedChars: 99990 });
    expect(fake.create.mock.calls[0][0].max_tokens).toBe(8000);
  });
  it("F03: cap+1 records one omitted body character", () => {
    const p = prepareNarrativeInput(input("A".repeat(99991)));
    expect(p.coverage).toMatchObject({ status: "partial", availableChars: 99991, includedChars: 99990 });
  });
  it("F04: tail excluded from the captured request stays partial in API and saved result", async () => {
    seed(input("A".repeat(99990) + "OMITTED_TAIL_947"));
    const r = await request();
    expect(fake.create.mock.calls[0][0].messages[0].content).not.toContain("OMITTED_TAIL_947");
    const n = r.messages.find((m) => m.type === "done").narrative;
    expect(n.coverage.status).toBe("partial");
    expect(JSON.parse(fake.blobs.get(ddKeys.narrative(SID, "e1"))!)).toEqual(n);
    expect(n.notes.some((x: { text: string }) => x.text.includes("batas pemrosesan"))).toBe(true);
  });
  it("F05: a header crossing the cap is omitted and never counted as examined", () => {
    const p = prepareNarrativeInput({ ...input(), classified: [classification(), classification("b")],
      contentByFile: new Map([["a", "A".repeat(99985)], ["b", "BODY"]]), extractReport: report([{ name: "a", status: "selesai" }, { name: "b", status: "selesai" }]) });
    expect(p.docsText).not.toContain("=== b");
    expect(p.coverage.files[1]).toMatchObject({ includedChars: 0, availableChars: 4 });
  });
  it("F06: surrogate pair at boundary is wholly omitted", () => {
    const p = prepareNarrativeInput(input("A".repeat(99989) + "😀TAIL"));
    expect(p.coverage.includedChars).toBe(99989);
    expect(p.docsText).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(p.contentByFile.get("a")).not.toContain("😀");
  });
  it("F07: citations found only in the omitted tail cannot ground a deed", async () => {
    fake.create.mockResolvedValue(response("end_turn", generated({ establishment: {
      number: "1", dateISO: "2020-01-01", purpose: "Pendirian", notary: "", menkumhamRef: "AHU-TAIL-12345", registrationRef: "", bnriRef: "", sourceFile: "a", verbatim: "Hanya di bagian akhir yang dihilangkan dari pemeriksaan narasi",
    } })));
    const n = await run(input("A".repeat(99990) + "AHU-TAIL-12345 Hanya di bagian akhir yang dihilangkan dari pemeriksaan narasi"));
    expect(n.notes.some((x) => x.text.includes("wajib diverifikasi") && x.text.includes("AHU-TAIL-12345"))).toBe(true);
    expect(n.notes.some((x) => x.text.includes("belum dapat dinyatakan sebagai fakta"))).toBe(true);
  });
  it.each([
    ["F08", "max_tokens", generated()], ["F09", "max_tokens", '{"amendments":['],
    ["F10", "end_turn", '{"amendments":['],
    ["F11-empty", "end_turn", ""], ["F11-refusal", "refusal", generated()],
    ["F11-unknown", "unknown", generated()], ["F11-null", null, generated()],
  ])("%s: incomplete/refused/unknown response causes no write and no done", async (_, stop, raw) => {
    seed(); fake.create.mockResolvedValue({ stop_reason: stop, content: [{ type: "text", text: raw }] });
    const r = await request();
    expect(r.messages.some((m) => m.type === "error")).toBe(true);
    expect(r.messages.some((m) => m.type === "done")).toBe(false);
    expect(fake.write).not.toHaveBeenCalled();
  });
  it("F10-fences: only code fences/whitespace may be removed; surrounding prose is rejected", () => {
    expect(parseNarrativeResponse("```json\n" + generated() + "\n```", "end_turn", { entityId: "e1" }).entityId).toBe("e1");
    expect(() => parseNarrativeResponse("Here is JSON: " + generated(), "end_turn", { entityId: "e1" })).toThrow();
  });
  it.each(["{}", generated({ establishment: "refusal" }), generated({ amendments: null }), generated({ businessPurpose: 7 }), generated({ directors: [{ name: "incomplete" }] }), generated({ businessActivities: [null] })])("F10-schema: semantically incomplete JSON %s is not completed", async (raw) => {
    seed(); fake.create.mockResolvedValue(response("end_turn", raw));
    const r = await request();
    expect(r.messages.some((m) => m.type === "error")).toBe(true);
    expect(r.messages.some((m) => m.type === "done")).toBe(false);
    expect(fake.write).not.toHaveBeenCalled();
  });
  it.each([["F12", "perlu_ocr", "memerlukan OCR"], ["F13", "gagal", "belum berhasil diekstrak"]])("%s: supplied unreadable document is not absent", async (_, status, phrase) => {
    const n = await run({ ...input("stale text"), extractReport: report([{ name: "a", status }]) });
    expect(fake.create).not.toHaveBeenCalled();
    expect(textBlocks(n)).toContain(phrase);
    expect(textBlocks(n)).not.toContain("[DOKUMEN TIDAK TERSEDIA]");
  });
  it("F14: classified source without matching text remains an unresolved reference", async () => {
    const n = await run({ ...input(), contentByFile: new Map(), extractReport: report([]) });
    expect(n.coverage?.files[0].availability).toBe("missing_text");
    expect(n.notes[0].text).not.toContain("[TIDAK DITEMUKAN]");
    expect(fake.create).not.toHaveBeenCalled();
  });
  it("F14-known-supplied: extraction record proves provision even when the body is unavailable", async () => {
    const n = await run({ ...input(), contentByFile: new Map() });
    expect(n.coverage?.files[0].availability).toBe("supplied_missing_text");
    expect(textBlocks(n)).toContain("dokumen ini telah disediakan dan tercatat telah diekstrak");
    expect(textBlocks(n)).not.toContain("Keberadaan dan status ekstraksinya");
    expect(fake.create).not.toHaveBeenCalled();
  });
  it.each([
    ["gagal", "gagal"], ["perlu_ocr", "perlu_ocr"], ["selesai", "gagal"], ["gagal", "selesai"],
  ])("F13/F16/F17-duplicates: %s + %s cannot supply stale body text", async (first, second) => {
    const n = await run({ ...input("STALE_BODY"), extractReport: report([{ name: "a", status: first }, { name: "a", status: second }]) });
    expect(n.coverage?.includedChars).toBe(0);
    expect(n.coverage?.modelCompletion).toBe("not_called");
    expect(fake.create).not.toHaveBeenCalled();
    if (first === second) expect(n.coverage?.files[0].availability).toBe(first);
  });
  it("F15: absent extraction report does not certify full coverage", async () => {
    const n = await run({ ...input(), extractReport: undefined });
    expect(n.coverage?.status).toBe("partial");
    expect(n.coverage?.limitations).toContain("extraction_uncertain");
  });
  it.each([null, 1, [], { files: null }, { files: [null] }, report([{ name: "a", status: 7 }])])("F16: malformed report %j stays uncertain", async (extractReport) => {
    const n = await run({ ...input(), extractReport });
    expect(n.coverage?.status).toBe("partial");
    expect(n.coverage?.limitations).toContain("extraction_uncertain");
  });
  it("F17: all unreadable route emits explicit not-called limitation with no client construction", async () => {
    seed({ ...input(), contentByFile: new Map(), extractReport: report([{ name: "a", status: "gagal" }]) });
    const r = await request();
    expect(r.messages.find((m) => m.type === "done").narrative.coverage.modelCompletion).toBe("not_called");
    expect(fake.construct).not.toHaveBeenCalled(); expect(fake.create).not.toHaveBeenCalled();
  });
  it("F16-export: malformed persisted extraction metadata cannot crash or certify the Word report", async () => {
    seed(); await request();
    for (const raw of ["{broken", "null", "7", "[]", '{"files":null}', '{"files":[null]}']) {
      fake.blobs.set(ddKeys.report(SID, "e1"), raw);
      const loaded = await loadEntityResults(SID);
      expect(loaded.results[0].extractReport).toBeNull();
      expect(loaded.results[0].narrative?.coverage?.status).toBe("legacy_unassessed");
      expect(wordText(await buildDdReportDocx(loaded))).toContain("cakupan");
    }
  });
  it("F18: no relevant classification is distinct from unreadable input", async () => {
    const n = await run({ ...input(), classified: [classification("a", "perizinan")] });
    expect(n.coverage?.limitations).toContain("no_relevant_documents");
    expect(n.coverage?.limitations).not.toContain("unreadable");
    expect(fake.create).not.toHaveBeenCalled();
  });
  it("F19: unclassified unreadable file is surfaced without a guessed aspect", async () => {
    const n = await run({ ...input(), classified: [], extractReport: report([{ name: "unknown.pdf", status: "perlu_ocr" }]) });
    expect(n.coverage?.files[0]).toMatchObject({ fileName: "unknown.pdf", relevant: false, availability: "perlu_ocr" });
    expect(n.notes.some((x) => x.text.includes("unknown.pdf"))).toBe(true);
    expect(fake.create).not.toHaveBeenCalled();
  });
  it("F20: model complete claim, forged coverage and omitted notes cannot remove server limitation", async () => {
    fake.create.mockResolvedValue(response("end_turn", generated({ coverage: { status: "full_supplied_input" }, notes: [], complete: true })));
    const n = await run(input("A".repeat(100100)));
    expect(n.coverage?.status).toBe("partial");
    expect(n.notes.some((x) => x.text.includes("batas pemrosesan"))).toBe(true);
    n.notes = [];
    expect(textBlocks(n)).toContain("batas pemrosesan");
  });
});

describe("H-9 frozen fixture map: persistence, report, caller and scope", () => {
  it("F21: actual route → save → shared reload preserves coverage and generation time", async () => {
    seed(); const r = await request();
    const n = r.messages.find((m) => m.type === "done").narrative;
    const loaded = await loadEntityResults(SID);
    expect(loaded.results[0].narrative).toEqual(n);
    expect(fake.write).toHaveBeenCalledTimes(1);
    expect(fake.write.mock.calls[0][0]).toBe(ddKeys.narrative(SID, "e1"));
  });
  it("F22: actual Word document contains mandatory partial and unreadable notices before corporate facts", async () => {
    const args = { ...input("A".repeat(100100)), extractReport: report([{ name: "a", status: "selesai" }, { name: "scan.pdf", status: "perlu_ocr" }]) };
    seed(args); await request();
    const loaded = await loadEntityResults(SID);
    loaded.results[0].narrative!.notes = [];
    const word = wordText(await buildDdReportDocx(loaded));
    expect(word).toContain("batas pemrosesan"); expect(word).toContain("scan.pdf"); expect(word).toContain("memerlukan OCR");
    expect(word.indexOf("batas pemrosesan")).toBeLessThan(word.indexOf("Data Korporasi"));
  });
  it.each([undefined, "pendahuluan_led", "exec_summary_led", "lut_pasar_modal", "findings_only"] as (DDReportFormat | undefined)[])("F22-formats: %s cannot omit coverage or describe extraction as examination", async (format) => {
    seed({ ...input("A".repeat(100100)), extractReport: report([{ name: "a", status: "selesai" }, { name: "scan.pdf", status: "perlu_ocr" }]) });
    await request();
    const loaded = await loadEntityResults(SID);
    loaded.transaction.reportFormat = format;
    loaded.results[0].narrative!.notes = [];
    const word = wordText(await buildDdReportDocx(loaded));
    expect(word).toContain("batas pemrosesan"); expect(word).toContain("scan.pdf"); expect(word).toContain("memerlukan OCR");
    expect(word).not.toContain("diekstrak dan diperiksa");
  });
  it("F21-caller: actual route stream and readback both render mandatory UI notices", async () => {
    seed(input("A".repeat(100100)));
    const res = await POST(new NextRequest("http://localhost/api/dd/narrative", { method: "POST", body: JSON.stringify({ sessionId: SID, entityId: "e1" }) }));
    let displayed: NarrativeNotice | null = null;
    await consumeNarrativeStream(res, vi.fn(), (n) => { displayed = n; }, vi.fn());
    expect(renderToStaticMarkup(React.createElement(NarrativeCoverageNotice, { notice: displayed! }))).toContain("batas pemrosesan");
    fake.blobs.set(ddKeys.extracted(SID, "e1"), block("a", "UPDATED"));
    fake.create.mockClear(); fake.write.mockClear();
    const get = await GET(new NextRequest(`http://localhost/api/dd/narrative?sessionId=${SID}&entityId=e1`));
    const hydrated = narrativeNoticeFromResponse(await get.json());
    expect(renderToStaticMarkup(React.createElement(NarrativeCoverageNotice, { notice: hydrated }))).toContain("telah berubah");
    expect(fake.create).not.toHaveBeenCalled(); expect(fake.write).not.toHaveBeenCalled();
  });
  it("F21/F23-caller: unavailable success is visible; failed regeneration retains old notice and original timestamp", async () => {
    seed({ ...input(), extractReport: report([{ name: "a", status: "gagal" }]) });
    const post = () => POST(new NextRequest("http://localhost/api/dd/narrative", { method: "POST", body: JSON.stringify({ sessionId: SID, entityId: "e1" }) }));
    let displayed: NarrativeNotice = { generatedAt: null, notes: [] };
    await consumeNarrativeStream(await post(), vi.fn(), (n) => { displayed = n; }, vi.fn());
    expect(renderToStaticMarkup(React.createElement(NarrativeCoverageNotice, { notice: displayed }))).toContain("belum berhasil diekstrak");
    seed(); await consumeNarrativeStream(await post(), vi.fn(), (n) => { displayed = n; }, vi.fn());
    const before = displayed;
    fake.create.mockResolvedValue(response("max_tokens"));
    const prior = vi.fn();
    await expect(consumeNarrativeStream(await post(), vi.fn(), (n) => { displayed = n; }, prior)).rejects.toThrow();
    expect(displayed).toBe(before); expect(prior).toHaveBeenCalledWith(before.generatedAt);
    expect(renderToStaticMarkup(React.createElement(NarrativeCoverageNotice, { notice: displayed }))).toContain("Hasil tersimpan");
    await expect(consumeNarrativeStream(new Response('{"type":"start"}\n'), vi.fn(), vi.fn(), vi.fn())).rejects.toThrow("terputus");
  });
  it("F23: failed rerun preserves prior bytes and identifies original saved time", async () => {
    seed(); await request();
    const before = fake.blobs.get(ddKeys.narrative(SID, "e1"))!;
    fake.write.mockClear(); fake.create.mockResolvedValue(response("max_tokens"));
    const r = await request();
    expect(fake.blobs.get(ddKeys.narrative(SID, "e1"))).toBe(before);
    expect(fake.write).not.toHaveBeenCalled();
    expect(r.messages.find((m) => m.type === "error").previousGeneratedAt).toBe(JSON.parse(before).generatedAt);
    const source = readFileSync("components/dd/DDStage5Review.tsx", "utf8");
    expect(source).toContain("msg.previousGeneratedAt");
    expect(source).toContain("hasil terdahulu"); expect(source).not.toContain("Bab II akan kosong");
  });
  it("F24: changed source/classification/report invalidates earlier current coverage on reload/export", async () => {
    seed(); await request();
    const before = fake.blobs.get(ddKeys.narrative(SID, "e1"))!;
    fake.blobs.set(ddKeys.extracted(SID, "e1"), block("a", "CHANGED"));
    const loaded = await loadEntityResults(SID);
    expect(loaded.results[0].narrative?.coverage?.status).toBe("legacy_unassessed");
    expect(wordText(await buildDdReportDocx(loaded))).toContain("telah berubah");
    expect(fake.blobs.get(ddKeys.narrative(SID, "e1"))).toBe(before);
    const old = JSON.parse(before);
    expect(reconcileNarrative(old, { ...input(), classified: [classification("a", "permodalan_saham")] })?.coverage?.status).toBe("legacy_unassessed");
    expect(reconcileNarrative(old, { ...input(), extractReport: report([{ name: "a", status: "gagal" }]) })?.coverage?.status).toBe("legacy_unassessed");
  });
  it("F25: late write from an earlier source snapshot is detected even when calls overlap", async () => {
    seed();
    let finish!: (r: ReturnType<typeof response>) => void;
    fake.create.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = request();
    await vi.waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1));
    fake.blobs.set(ddKeys.extracted(SID, "e1"), block("a", "NEW SOURCE"));
    await request();
    finish(response()); await first;
    expect((await loadEntityResults(SID)).results[0].narrative?.coverage?.status).toBe("legacy_unassessed");
  });
  it("F25-same-input: overlapping writes preserve the returned generation time and unchanged-input coverage", async () => {
    seed(); let finish!: (r: ReturnType<typeof response>) => void;
    fake.create.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = request(); await vi.waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1));
    await request(); finish(response()); const last = await first;
    const loaded = (await loadEntityResults(SID)).results[0].narrative!;
    expect(loaded.coverage?.status).toBe("full_supplied_input");
    expect(loaded.generatedAt).toBe(last.messages.find((m) => m.type === "done").narrative.generatedAt);
  });
  it("F26: legacy and malformed coverage cannot silently become fully covered; no migration", async () => {
    seed(); fake.blobs.set(ddKeys.narrative(SID, "e1"), generated());
    const loaded = await loadEntityResults(SID);
    expect(wordText(await buildDdReportDocx(loaded))).toContain("cakupan");
    expect(loaded.results[0].narrative?.coverage?.status).toBe("legacy_unassessed");
    expect(fake.write).not.toHaveBeenCalled();
    for (const bad of [null, 1, [], {}, { version: 1, status: "full_supplied_input" }]) {
      expect(parseNarrativeCoverage(bad)).toBeNull();
      expect(coverageNotes(bad)[0].text).toContain("belum dapat dipastikan");
    }
    const good = await run(input());
    const forged = { ...good, coverage: { ...good.coverage, availableChars: 999, includedChars: 999 } };
    expect(reconcileNarrative(forged, input())?.coverage?.status).toBe("legacy_unassessed");
  });
  it.each([null, [], {}, { sessionId: "../unsafe", entityId: "e1" }, { sessionId: SID, entityId: "../e2" }, { sessionId: 7, entityId: "e1" }])("F27: invalid request %j has zero reads/provider/writes", async (body) => {
    expect((await request(body)).status).toBe(400);
    expect(fake.read).not.toHaveBeenCalled(); expect(fake.create).not.toHaveBeenCalled(); expect(fake.write).not.toHaveBeenCalled();
  });
  it("F28: transaction/classification entity mismatches cannot dispatch or alter other records", async () => {
    seed(); fake.blobs.set("other-record", "UNCHANGED");
    expect((await request({ sessionId: SID, entityId: "e2" })).status).toBe(400);
    fake.blobs.set(ddKeys.classified(SID, "e1"), JSON.stringify([{ ...classification(), entityId: "e2" }]));
    expect((await request()).status).toBe(400);
    expect(fake.create).not.toHaveBeenCalled(); expect(fake.write).not.toHaveBeenCalled();
    expect(fake.blobs.get("other-record")).toBe("UNCHANGED");
    const mismatch = reconcileNarrative({ ...JSON.parse(generated()), entityId: "e2", businessPurpose: "OTHER_ENTITY_SECRET" }, input());
    expect(JSON.stringify(mismatch)).not.toContain("OTHER_ENTITY_SECRET");
  });
  it("F27/F28-readback: GET validates identifiers and entity membership before reading entity stores", async () => {
    expect((await GET(new NextRequest("http://localhost/api/dd/narrative?sessionId=../bad&entityId=e1"))).status).toBe(400);
    expect(fake.read).not.toHaveBeenCalled();
    seed(); fake.read.mockClear();
    expect((await GET(new NextRequest(`http://localhost/api/dd/narrative?sessionId=${SID}&entityId=e2`))).status).toBe(400);
    expect(fake.read.mock.calls.map((x) => x[0])).toEqual([ddKeys.transaction(SID)]);
    expect(fake.create).not.toHaveBeenCalled(); expect(fake.write).not.toHaveBeenCalled();
  });
});
