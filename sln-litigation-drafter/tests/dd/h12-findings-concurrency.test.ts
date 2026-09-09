import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { DDFinding } from "@/types/dd";
import { ddKeys } from "@/lib/dd/blob-keys";

const fake = vi.hoisted(() => ({
  records: new Map<string, { body: string; etag: string }>(), get: vi.fn(), put: vi.fn(), serial: 0,
  provider: vi.fn(), currency: vi.fn(), verify: vi.fn(), plan: vi.fn(), aspect: vi.fn(), transaction: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: fake.provider }; } }));
vi.mock("@/config/ddChapters", () => ({ planChapters: fake.plan, chapterForAspect: () => ({ subs: [{ title: "Synthetic aspect" }] }), isTransactionChapter: (c: { kind: string }) => c.kind === "transaksi" }));
vi.mock("@/lib/dd/redflag", async original => ({ ...await original<typeof import("@/lib/dd/redflag")>(), analyzeAspect: fake.aspect, analyzeTransactionChapters: fake.transaction }));
vi.mock("@/lib/dd/currency", async (original) => ({ ...await original<typeof import("@/lib/dd/currency")>(), checkCurrency: fake.currency }));
vi.mock("@/lib/dd/verify", () => ({ verifyFindings: fake.verify }));
vi.mock("@vercel/blob", () => ({
  get: fake.get, put: fake.put,
  BlobPreconditionFailedError: class extends Error {}, BlobNotFoundError: class extends Error {},
}));
import { BlobPreconditionFailedError } from "@vercel/blob";
import { GET, PUT } from "@/app/api/dd/findings/route";
import { POST as analyze } from "@/app/api/dd/analyze/route";
import { readVersionedBlobText, writeVersionedBlobText } from "@/lib/blob";

const sid = "h12_synthetic_session", eid = "e1";
const key = `litigation-memory/${ddKeys.findings(sid, eid)}`;
const finding = (): DDFinding => ({ id: "e1-f1", entityId: eid, aspectId: "perizinan", dimension: "risiko",
  severity: "material", anchor: "Synthetic source", sourceFile: "synthetic.txt", problem: "Original",
  whyItMatters: "Synthetic", suggestedFix: "Review", status: "open", verified: false,
  verification: { status: "source_unresolved", reason: "Synthetic unresolved source" },
});
const request = (body: unknown) => new NextRequest("http://localhost/api/dd/findings", {
  method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const payload = (status = "dismissed", revision: unknown = '"v1"') => ({ sessionId: sid, entityId: eid,
  revision, reviews: [{ id: "e1-f1", status }],
});
beforeEach(() => {
  vi.clearAllMocks(); fake.records.clear(); fake.serial = 1;
  fake.provider.mockRejectedValue(new Error("Unexpected provider call"));
  fake.currency.mockResolvedValue({});
  fake.verify.mockImplementation(async (_client, findings) => findings);
  fake.plan.mockReturnValue([]); fake.aspect.mockResolvedValue({ findings: [finding()], analyses: [] }); fake.transaction.mockResolvedValue([]);
  fake.records.set(key, { body: JSON.stringify([finding()]), etag: '"v1"' });
  fake.get.mockImplementation(async (path: string) => {
    const r = fake.records.get(path);
    return r ? { statusCode: 200, stream: new Response(r.body).body, blob: { etag: r.etag } } : null;
  });
  fake.put.mockImplementation(async (path: string, body: string, options: { ifMatch?: string; allowOverwrite?: boolean }) => {
    // Preconditions are checked at the commit point, not when the caller read.
    const old = fake.records.get(path);
    if ((options.ifMatch && old?.etag !== options.ifMatch) || (options.allowOverwrite === false && old)) {
      throw new BlobPreconditionFailedError();
    }
    const etag = `"v${++fake.serial}"`;
    fake.records.set(path, { body, etag });
    return { url: path, etag };
  });
});

describe("H-12 real findings route and storage boundary", () => {
  it("returns matching body/revision and disables response and storage cache", async () => {
    const r = await GET(new NextRequest(`http://localhost/api/dd/findings?sessionId=${sid}&entityId=${eid}`));
    expect(await r.json()).toEqual({ findings: [finding()], revision: '"v1"' });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(fake.get).toHaveBeenCalledWith(key, expect.objectContaining({ useCache: false }));
  });
  it("accepts exactly one competing review and preserves derived assurance", async () => {
    const replies = await Promise.all([PUT(request(payload("dismissed"))), PUT(request(payload("accepted")))]);
    expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
    const saved = JSON.parse(fake.records.get(key)!.body)[0];
    expect(["dismissed", "accepted"]).toContain(saved.status);
    expect(saved.verification).toEqual(finding().verification);
    expect(saved.verified).toBe(false);
    expect(fake.put.mock.calls.every(c => c[2].ifMatch === '"v1"')).toBe(true);
  });
  it("requires a precondition without writing", async () => {
    expect((await PUT(request({ ...payload(), revision: undefined }))).status).toBe(428);
    expect(fake.put).not.toHaveBeenCalled();
  });
  it("does not turn a read error into an empty successful response", async () => {
    fake.get.mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await GET(new NextRequest(`http://localhost/api/dd/findings?sessionId=${sid}&entityId=${eid}`))).status).toBe(503);
    expect(fake.put).not.toHaveBeenCalled();
  });
  it.each(["*", 'W/"v1"', '"v1", "v2"', "", 1, [], {}])("rejects invalid revision %j", async revision => {
    expect((await PUT(request(payload("open", revision)))).status).toBe(400);
    expect(fake.put).not.toHaveBeenCalled();
  });
  it.each([
    null, [], { ...payload(), reviews: null }, { ...payload(), reviews: [{ id: "foreign", status: "open" }] },
    { ...payload(), reviews: [{ id: "e1-f1", status: "override" }] },
    { ...payload(), reviews: [{ id: "e1-f1", status: "open", editedProblem: 3 }] },
    { ...payload(), reviews: [{ id: "e1-f1", status: "open", verified: true }] },
    { ...payload(), reviews: [payload().reviews[0], payload().reviews[0]] },
    { ...payload(), entityId: "../escape" }, { ...payload(), sessionId: "../escape" },
    { ...payload(), findings: [] },
  ])("rejects malformed, foreign and injected review payload %j", async body => {
    expect((await PUT(request(body))).status).toBe(400); expect(fake.put).not.toHaveBeenCalled();
  });
  it("distinguishes saved empty findings from absent findings and cannot create through PUT", async () => {
    fake.records.set(key, { body: "[]", etag: '"v1"' });
    const url = `http://localhost/api/dd/findings?sessionId=${sid}&entityId=${eid}`;
    expect(await (await GET(new NextRequest(url))).json()).toEqual({ findings: [], revision: '"v1"' });
    fake.records.delete(key);
    expect(await (await GET(new NextRequest(url))).json()).toEqual({ findings: [], revision: null });
    expect((await PUT(request(payload()))).status).toBe(409); expect(fake.put).not.toHaveBeenCalled();
  });
  it("preserves untouched findings, supports reopening and clearing replacement wording", async () => {
    const one = { ...finding(), status: "edited", editedProblem: "Old draft" }, two = { ...finding(), id: "e1-f2" };
    fake.records.set(key, { body: JSON.stringify([one, two]), etag: '"v1"' });
    const r = await PUT(request(payload("open")));
    expect(r.status).toBe(200);
    const saved = JSON.parse(fake.records.get(key)!.body);
    expect(saved).toEqual([finding(), two]);
  });
  it.each(["broken JSON", "null", "{}", '[{"id":"x"}]', JSON.stringify([{ ...finding(), entityId: "e2" }])])("fails closed on invalid stored data %s", async body => {
    fake.records.set(key, { body, etag: '"v1"' });
    expect((await PUT(request(payload()))).status).toBe(503); expect(fake.put).not.toHaveBeenCalled();
  });
  it("rejects missing ETag, unexpected response and stream failures", async () => {
    for (const response of [undefined, { statusCode: 304 }, { statusCode: 200, stream: new Response("[]").body, blob: { etag: "" } },
      { statusCode: 200, stream: new ReadableStream({ start(c) { c.error(new Error("broken stream")); } }), blob: { etag: '"v1"' } }]) {
      fake.get.mockResolvedValueOnce(response);
      await expect(readVersionedBlobText("test")).rejects.toThrow();
    }
  });
  it("does not acknowledge a successful write without a returned ETag", async () => {
    fake.put.mockResolvedValueOnce({ url: key });
    await expect(writeVersionedBlobText("test", "[]", '"v1"')).rejects.toThrow("Unconfirmed");
  });
});

function seedAnalysis() {
  const seed = (path: string, body: unknown) => fake.records.set(`litigation-memory/${path}`, { body: typeof body === "string" ? body : JSON.stringify(body), etag: '"seed"' });
  seed(ddKeys.transaction(sid), { id: sid, type: "acquisition", entities: [{ id: eid, name: "PT Synthetic", role: "target", listingStatus: "non_tbk", isBumn: false, files: [] }] });
  seed(ddKeys.extracted(sid, eid), "Synthetic corpus");
  seed(ddKeys.classified(sid, eid), []); seed(ddKeys.gaps(sid, eid), []);
}
async function runAnalysis() {
  const r = await analyze(new NextRequest("http://localhost/api/dd/analyze", { method: "POST", body: JSON.stringify({ sessionId: sid, entityId: eid }) }));
  return { status: r.status, messages: (await r.text()).trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) };
}
describe("H-12 actual analysis checkpoint interleavings", () => {
  it("chains every checkpoint to its own acknowledged revision and returns final body/revision", async () => {
    seedAnalysis(); const r = await runAnalysis();
    expect(r.messages.at(-1)).toMatchObject({ type: "done", revision: fake.records.get(key)!.etag, findings: JSON.parse(fake.records.get(key)!.body) });
    const calls = fake.put.mock.calls.filter(c => c[0] === key);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls[0][2].ifMatch).toBe('"v1"');
    for (let i = 1; i < calls.length; i++) expect(calls[i][2].ifMatch).not.toBe(calls[i - 1][2].ifMatch);
    expect(fake.provider).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3, 4])("stops at rejected checkpoint %i without subsequent supporting writes or done", async checkpoint => {
    seedAnalysis(); const put = fake.put.getMockImplementation()!; let seen = 0;
    const winner = { ...finding(), status: "open", editedProblem: "" };
    fake.records.set(key, { body: JSON.stringify([{ ...finding(), status: "dismissed", editedProblem: "OLD" }]), etag: '"v1"' });
    fake.put.mockImplementation(async (...args) => {
      if (args[0] === key && ++seen === checkpoint) fake.records.set(key, { body: JSON.stringify([winner]), etag: '"winner"' });
      return put(...args);
    });
    const r = await runAnalysis();
    expect(r.messages.at(-1)).toMatchObject({ type: "error" });
    expect(r.messages.some(m => m.type === "done")).toBe(false);
    expect(seen).toBe(checkpoint);
    expect(JSON.parse(fake.records.get(key)!.body)).toEqual([winner]);
    expect(fake.put.mock.calls.filter(c => c[0] !== key)).toHaveLength((checkpoint - 1) * 2);
    if (checkpoint === 1) { expect(fake.currency).not.toHaveBeenCalled(); expect(fake.verify).not.toHaveBeenCalled(); }
    if (checkpoint < 4) expect(fake.verify).not.toHaveBeenCalled();
  });
  it.each([false, true])("only one competing analysis wins (initial absence %s)", async absent => {
    seedAnalysis(); if (absent) fake.records.delete(key);
    const r = await Promise.all([runAnalysis(), runAnalysis()]);
    expect(r.filter(x => x.messages.at(-1).type === "done")).toHaveLength(1);
    expect(r.filter(x => x.messages.at(-1).type === "error")).toHaveLength(1);
    if (absent) {
      expect(fake.put.mock.calls.filter(c => c[0] === key && !c[2].ifMatch).every(c => c[2].allowOverwrite === false && c[2].addRandomSuffix === false)).toBe(true);
    }
  });
  it("stops before any provider or write when the findings read fails", async () => {
    seedAnalysis(); fake.get.mockRejectedValueOnce(new Error("Read denied"));
    expect((await runAnalysis()).status).toBe(503);
    expect(fake.put).not.toHaveBeenCalled(); expect(fake.provider).not.toHaveBeenCalled(); expect(fake.currency).not.toHaveBeenCalled();
  });
  it("never reports done after supporting persistence fails", async () => {
    seedAnalysis(); const put = fake.put.getMockImplementation()!;
    fake.put.mockImplementation(async (...args) => { if (args[0] !== key) throw new Error("Supporting write failed"); return put(...args); });
    const r = await runAnalysis();
    expect(r.messages.at(-1).type).toBe("error");
    expect(fake.put.mock.calls.filter(c => c[0] === key)).toHaveLength(1);
    expect(fake.records.get(key)!.etag).not.toBe('"v1"');
  });
  it.each(["aspect", "transaction"])("conflict after %s processing escapes soft-failure handlers and stops later work", async stage => {
    seedAnalysis();
    if (stage === "aspect") {
      fake.records.set(`litigation-memory/${ddKeys.classified(sid, eid)}`, { body: JSON.stringify([{ fileName: "synthetic.txt", aspectId: "perizinan", expectedDocId: null }]), etag: '"seed"' });
      fake.records.set(`litigation-memory/${ddKeys.extracted(sid, eid)}`, { body: "=== synthetic.txt ===\n[Metadata: kategori=izin; metode=text]\n" + "Synthetic source. ".repeat(20), etag: '"seed"' });
    } else fake.plan.mockReturnValue([{ kind: "transaksi", subs: [{ title: "Synthetic transaction" }] }]);
    const put = fake.put.getMockImplementation()!; let checkpoints = 0;
    fake.put.mockImplementation(async (...args) => {
      if (args[0] === key && ++checkpoints === 2) fake.records.set(key, { body: JSON.stringify([{ ...finding(), status: "dismissed" }]), etag: '"winner"' });
      return put(...args);
    });
    const r = await runAnalysis();
    expect(stage === "aspect" ? fake.aspect : fake.transaction).toHaveBeenCalledTimes(1);
    expect(r.messages.at(-1).type).toBe("error"); expect(r.messages.some(m => m.type === "done")).toBe(false);
    expect(checkpoints).toBe(2); expect(fake.put.mock.calls.filter(c => c[0] !== key)).toHaveLength(2);
    expect(fake.currency).not.toHaveBeenCalled(); expect(fake.verify).not.toHaveBeenCalled();
    expect(fake.records.get(key)!.etag).toBe('"winner"');
  });
});
