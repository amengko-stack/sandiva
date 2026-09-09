import { afterEach, describe, expect, it, vi } from "vitest";
import { FindingsSaveQueue, type ReviewDraft } from "@/lib/dd/findings-save";
import type { DDFinding } from "@/types/dd";

const finding = (): DDFinding => ({ id: "f1", entityId: "e1", aspectId: null, dimension: "risiko", severity: "minor",
  anchor: "", sourceFile: null, problem: "Synthetic", whyItMatters: "Synthetic", suggestedFix: "Review", verified: false, status: "open" });
const snap = (findings = [finding()], revision: string | null = '"v1"') => ({ findings, revision });
const deferred = <T>() => { let resolve!: (x: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("H-12 queue used by the review caller", () => {
  it("queues B behind A and only labels B saved when its own response arrives", async () => {
    const a = deferred<Response>(), b = deferred<Response>(); const changes: ReviewDraft[] = [];
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snap())).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const q = new FindingsSaveQueue("session12", (_, v) => changes.push(v), fetcher);
    await q.load("e1"); q.edit("e1", "f1", { status: "dismissed" }); const saved = q.save("e1"); await tick();
    q.edit("e1", "f1", { status: "accepted" }); void q.save("e1");
    expect(fetcher).toHaveBeenCalledTimes(2);
    a.resolve(Response.json(snap([{ ...finding(), status: "dismissed" }], '"v2"'))); await tick();
    expect(q.get("e1")).toMatchObject({ dirty: true, status: "pending", findings: [{ status: "accepted" }] });
    expect(JSON.parse(fetcher.mock.calls[2][1].body).revision).toBe('"v2"');
    b.resolve(Response.json(snap([{ ...finding(), status: "accepted" }], '"v3"'))); await saved;
    expect(q.get("e1")).toMatchObject({ dirty: false, status: "saved", revision: '"v3"' });
    expect(changes.filter(d => d.status === "saved").map(d => d.findings[0].status)).toEqual(["open", "accepted"]);
    q.dispose();
  });
  it("keeps conflicting draft, blocks retries/analysis/navigation, then explicitly reloads", async () => {
    vi.useFakeTimers(); const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snap())).mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockResolvedValueOnce(Response.json(snap([{ ...finding(), status: "accepted" }], '"v2"')));
    const q = new FindingsSaveQueue("session12", () => {}, fetcher);
    await q.load("e1"); q.edit("e1", "f1", { status: "dismissed" }); await q.save("e1");
    expect(q.get("e1")).toMatchObject({ dirty: true, status: "conflict", findings: [{ status: "dismissed" }] });
    expect(q.beginAnalysis("e1")).toBe(false); expect(q.blocked()).toBe(true);
    q.edit("e1", "f1", { editedProblem: "Local draft retained" }); await vi.advanceTimersByTimeAsync(5000);
    await q.save("e1"); await q.load("e1"); expect(fetcher).toHaveBeenCalledTimes(2);
    await q.load("e1", true); expect(q.get("e1")).toMatchObject({ dirty: false, status: "saved", findings: [{ status: "accepted" }] });
    q.dispose();
  });
  it("lost ACK remains unconfirmed and a conditional retry may conflict", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snap())).mockRejectedValueOnce(new Error("ACK lost after commit"))
      .mockResolvedValueOnce(Response.json({}, { status: 409 }));
    const q = new FindingsSaveQueue("session12", () => {}, fetcher);
    await q.load("e1"); q.edit("e1", "f1", { status: "accepted" }); await q.save("e1");
    expect(q.get("e1")).toMatchObject({ dirty: true, status: "failed", revision: '"v1"' });
    await q.save("e1"); expect(q.get("e1").status).toBe("conflict");
    expect(JSON.parse(fetcher.mock.calls[2][1].body).revision).toBe('"v1"'); q.dispose();
  });
  it("hydrates empty saved record, accepts analysis completion without PUT and blocks dirty analysis", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(snap([], '"empty"')));
    const q = new FindingsSaveQueue("session12", () => {}, fetcher);
    await q.load("e1"); expect(q.get("e1")).toMatchObject({ findings: [], revision: '"empty"', status: "saved" });
    expect(q.beginAnalysis("e1")).toBe(true); q.completeAnalysis("e1", snap()); q.endAnalysis("e1");
    expect(fetcher).toHaveBeenCalledTimes(1); q.edit("e1", "f1", { status: "dismissed" });
    expect(q.beginAnalysis("e1")).toBe(false); expect(() => q.completeAnalysis("e1", snap())).toThrow(); q.dispose();
  });
  it("ignores stale hydration and save responses after disposal/session change", async () => {
    const late = deferred<Response>(), changes = vi.fn();
    const fetcher = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(Response.json(snap()));
    const old = new FindingsSaveQueue("old_session", changes, fetcher); const pending = old.load("e1"); old.dispose(); changes.mockClear();
    late.resolve(Response.json(snap())); await pending; expect(changes).not.toHaveBeenCalled();
    const a = deferred<Response>(); fetcher.mockReturnValueOnce(a.promise);
    const q = new FindingsSaveQueue("new_session", changes, fetcher); await q.load("e1"); q.edit("e1", "f1", { status: "accepted" });
    const save = q.save("e1"); await tick(); q.dispose(); changes.mockClear();
    a.resolve(Response.json(snap([{ ...finding(), status: "accepted" }], '"v2"'))); await save; expect(changes).not.toHaveBeenCalled();
  });
  it("does not apply stale hydration after analysis starts and supports StrictMode replay", async () => {
    const late = deferred<Response>(); const changed = vi.fn();
    const fetcher = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(Response.json(snap()));
    const q = new FindingsSaveQueue("session12", changed, fetcher); const first = q.load("e1"); q.dispose(); q.activate();
    await q.load("e1"); q.edit("e1", "f1", { status: "dismissed" });
    late.resolve(Response.json(snap([{ ...finding(), status: "accepted" }], '"old"'))); await first;
    expect(q.get("e1").findings[0].status).toBe("dismissed"); q.dispose();
  });
  it("blocks entity B analysis while entity A has an unsaved review", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(snap())).mockResolvedValueOnce(Response.json(snap([], '"b"')));
    const q = new FindingsSaveQueue("session12", () => {}, fetcher);
    await q.load("e1"); await q.load("e2"); q.edit("e1", "f1", { status: "dismissed" });
    expect(q.beginAnalysis("e2")).toBe(false); q.dispose();
  });
});
