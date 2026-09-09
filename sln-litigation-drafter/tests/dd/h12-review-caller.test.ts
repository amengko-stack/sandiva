import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import * as saves from "@/lib/dd/findings-save";
import { NextRequest } from "next/server";
import type { DDFinding } from "@/types/dd";

const storage = vi.hoisted(() => ({ body: "[]", revision: '"v1"', writes: 0, race: false, present: true }));
vi.mock("@vercel/blob", () => ({
  BlobNotFoundError: class extends Error {}, BlobPreconditionFailedError: class extends Error {},
  get: async () => storage.present ? ({ statusCode: 200, stream: new Response(storage.body).body, blob: { etag: storage.revision } }) : null,
  put: async (_path: string, body: string, options: { ifMatch: string }) => {
    if (storage.race) storage.revision = '"other"';
    if (options.ifMatch !== storage.revision) throw new (await import("@vercel/blob")).BlobPreconditionFailedError();
    storage.body = body; storage.revision = `"v${++storage.writes + 1}"`; return { url: "synthetic", etag: storage.revision };
  },
}));
import { GET, PUT } from "@/app/api/dd/findings/route";
import { renderFindingsTable } from "@/lib/dd/findings-render";

const finding = (): DDFinding => ({ id: "f1", entityId: "e1", aspectId: null, dimension: "risiko", severity: "minor",
  anchor: "", sourceFile: null, problem: "Synthetic original", whyItMatters: "Synthetic", suggestedFix: "Review", verified: false, status: "open" });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
type Node = { type: unknown; props: Record<string, any> };
function nodes(value: any): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value && typeof value === "object" && value.props ? [value, ...nodes(value.props.children)] : [];
}
// Execute the actual component callbacks with deterministic hook state and effects.
// No DOM approximation is used as evidence for styling or browser navigation.
function harness(path: string, context: any) {
  const slots: any[] = []; let cursor = 0; let effects: (() => void)[] = [];
  const useState = (initial: any) => { const n = cursor++; if (!(n in slots)) slots[n] = typeof initial === "function" ? initial() : initial;
    return [slots[n], (next: any) => { slots[n] = typeof next === "function" ? next(slots[n]) : next; }]; };
  const react = {
    useState, useRef: (v: any) => useState({ current: v })[0], useCallback: (fn: any) => fn,
    useReducer: (reducer: any, initial: any) => { const [value, set] = useState(initial); return [value, (a: any) => set((s: any) => reducer(s, a))]; },
    createContext: () => ({ Provider: "provider" }),
    useEffect: (effect: () => any, deps: unknown[] = []) => { const n = cursor++; const old = slots[n];
      if (!old || deps.some((d, i) => !Object.is(d, old.deps[i]))) effects.push(() => { old?.cleanup?.(); slots[n] = { deps, cleanup: effect() }; }); },
  };
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: any = {};
  new Function("require", "exports", code)((name: string) => {
    if (name === "react") return react; if (name === "react/jsx-runtime") return jsx;
    if (name === "@/context/DDContext") return { useDD: () => context };
    if (name === "@/lib/dd/findings-save") return saves;
    if (name === "@/config/ddAspects") return { aspectLabel: () => "Synthetic" };
    if (name === "@/components/dd/DDSourcePreview" || name === "@/components/dd/DDChecklistManager" || name === "next/link") return { default: "placeholder" };
    throw new Error(`Unexpected caller import: ${name}`);
  }, exports);
  return { render: (name = "default", props = {}) => { cursor = 0; effects = []; const tree = exports[name](props); for (const effect of effects) effect(); return tree; },
    dispose: () => { for (const slot of slots) slot?.cleanup?.(); } };
}
let guard: (() => boolean) | null;
const context = { state: { sessionId: "session12", transaction: { entities: [{ id: "e1", name: "PT Synthetic" }] }, progress: { e1: { analyzed: true } }, consolidated: false },
  dispatch: vi.fn(), setReviewNavigationGuard: (g: (() => boolean) | null) => { guard = g; }, canLeaveReview: () => !guard?.() };
let wire: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  storage.body = JSON.stringify([finding()]); storage.revision = '"v1"'; storage.writes = 0; storage.race = false; storage.present = true;
  context.dispatch.mockClear(); guard = null;
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => true) });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  wire = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/dd/findings")) {
      const req = new NextRequest(`http://localhost${url}`, { ...init, signal: init?.signal ?? undefined }); return init?.method === "PUT" ? PUT(req) : GET(req);
    }
    if (url.startsWith("/api/dd/narrative") || url.startsWith("/api/dd/consolidate")) return Response.json({});
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", wire);
});
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); });

describe("H-12 actual UI -> route -> conditional storage -> reload", () => {
  it("saves only review fields, reloads accepted wording and supplies report-renderer input", async () => {
    const h = harness("components/dd/DDStage5Review.tsx", context); cleanups.push(h.dispose);
    h.render(); await tick(); let tree = h.render();
    const card = nodes(tree).find(n => n.props.f?.id === "f1")!;
    card.props.onAction("f1", { status: "edited", editedProblem: "Synthetic lawyer replacement" });
    tree = h.render(); expect(guard?.()).toBe(true);
    nodes(tree).find(n => n.props.children === "Simpan review")!.props.onClick(); await tick(); tree = h.render();
    expect(storage.writes).toBe(1); expect(guard?.()).toBe(false);
    const body = JSON.parse(wire.mock.calls.find(c => c[1]?.method === "PUT")![1]!.body as string);
    expect(body.findings).toBeUndefined(); expect(body.reviews).toEqual([{ id: "f1", status: "edited", editedProblem: "Synthetic lawyer replacement" }]);
    expect(JSON.parse(storage.body)[0].verified).toBe(false);
    h.dispose();
    const fresh = harness("components/dd/DDStage5Review.tsx", context); cleanups.push(fresh.dispose);
    fresh.render(); await tick();
    const loaded = nodes(fresh.render()).find(n => n.props.f?.id === "f1")!.props.f;
    expect(loaded.editedProblem).toBe("Synthetic lawyer replacement");
    expect(JSON.stringify(renderFindingsTable([loaded]))).toContain("Synthetic lawyer replacement");
  });
  it("conflict keeps the visible draft and export is blocked until explicit discard/reload", async () => {
    const h = harness("components/dd/DDStage5Review.tsx", context); cleanups.push(h.dispose);
    h.render(); await tick(); let tree = h.render();
    nodes(tree).find(n => n.props.f?.id === "f1")!.props.onAction("f1", { status: "dismissed" });
    storage.race = true; tree = h.render(); nodes(tree).find(n => n.props.children === "Simpan review")!.props.onClick(); await tick(); tree = h.render();
    await vi.waitFor(() => expect(nodes(h.render()).some(n => n.props.role === "alert")).toBe(true)); tree = h.render();
    expect(nodes(tree).find(n => n.props.f?.id === "f1")!.props.f.status).toBe("dismissed");
    nodes(tree).find(n => n.props.children === "Lanjut ke Ekspor →")!.props.onClick();
    expect(context.dispatch.mock.calls.some(c => c[0].type === "SET_STAGE")).toBe(false);
    expect(guard?.()).toBe(true); expect(storage.writes).toBe(0);
    nodes(tree).find(n => n.props.children === "Buang draft lokal dan muat ulang temuan tersimpan")!.props.onClick(); await tick(); tree = h.render();
    expect(nodes(tree).find(n => n.props.f?.id === "f1")!.props.f.status).toBe("open"); expect(guard?.()).toBe(false);
  });
  it("actual context blocks stage/session reset and sidebar blocks menu navigation while guarded", () => {
    const h = harness("context/DDContext.tsx", null); cleanups.push(h.dispose);
    let provider = h.render("DDProvider", { children: null }); let c = provider.props.value;
    c.setReviewNavigationGuard(() => true); c.dispatch({ type: "SET_STAGE", stage: 6 });
    provider = h.render("DDProvider", { children: null }); c = provider.props.value;
    expect(c.state.stage).toBe(1); expect(c.state.error).toContain("Selesaikan");
    const session = c.state.sessionId; c.dispatch({ type: "RESET" });
    expect(h.render("DDProvider", { children: null }).props.value.state.sessionId).toBe(session);
    const sidebar = harness("components/dd/DDSidebar.tsx", c); cleanups.push(sidebar.dispose);
    const link = nodes(sidebar.render()).find(n => n.props.href === "/")!; const preventDefault = vi.fn();
    link.props.onClick({ preventDefault }); expect(preventDefault).toHaveBeenCalled();
    c.setReviewNavigationGuard(null); c.dispatch({ type: "SET_STAGE", stage: 6 });
    expect(h.render("DDProvider", { children: null }).props.value.state.stage).toBe(6);
  });
  it("actual analysis completion hydrates its revision without autosave and retains the H-9 follow-on caller", async () => {
    const original = wire.getMockImplementation()!;
    wire.mockImplementation(async (url, init) => {
      if (url === "/api/dd/analyze") {
        storage.body = JSON.stringify([{ ...finding(), status: "accepted" }]); storage.revision = '"analysis"';
        return new Response(JSON.stringify({ type: "done", findings: JSON.parse(storage.body), revision: storage.revision }) + "\n");
      }
      if (url === "/api/dd/narrative" && init?.method === "POST") return new Response(JSON.stringify({ type: "done", generatedAt: "2026-09-09T00:00:00Z", coverageNotes: ["Synthetic coverage"] }) + "\n");
      return original(url, init);
    });
    const h = harness("components/dd/DDStage5Review.tsx", context); cleanups.push(h.dispose);
    h.render(); await tick(); const tree = h.render();
    await nodes(tree).find(n => n.props.children === "Jalankan analisis")!.props.onClick(); await tick();
    expect(nodes(h.render()).find(n => n.props.f?.id === "f1")!.props.f.status).toBe("accepted");
    expect(context.dispatch.mock.calls.some(c => c[0].type === "MARK_PROGRESS")).toBe(true);
    expect(wire.mock.calls.some(c => c[0] === "/api/dd/narrative" && c[1]?.method === "POST")).toBe(true);
    expect(wire.mock.calls.some(c => c[0] === "/api/dd/consolidate" && c[1]?.method === "POST")).toBe(true);
    expect(storage.writes).toBe(0); expect(guard?.()).toBe(false);
  });
  it("actual truncated analysis response never marks completion or calls narrative", async () => {
    const original = wire.getMockImplementation()!;
    wire.mockImplementation(async (url, init) => url === "/api/dd/analyze" ? new Response('{"type":"step","label":"Partial"}\n') : original(url, init));
    const h = harness("components/dd/DDStage5Review.tsx", context); cleanups.push(h.dispose);
    h.render(); await tick(); await nodes(h.render()).find(n => n.props.children === "Jalankan analisis")!.props.onClick();
    expect(context.dispatch.mock.calls.some(c => c[0].type === "MARK_PROGRESS")).toBe(false);
    expect(context.dispatch.mock.calls.some(c => c[0].type === "SET_ERROR" && c[0].error.includes("terputus"))).toBe(true);
    expect(wire.mock.calls.some(c => c[0] === "/api/dd/narrative" && c[1]?.method === "POST")).toBe(false);
    expect(nodes(h.render()).some(n => n.props.children === "Buang draft lokal dan muat ulang temuan tersimpan")).toBe(true);
  });
  it("failed first analysis offers reload of the valid partial checkpoint", async () => {
    storage.body = "[]"; storage.present = false; const original = wire.getMockImplementation()!;
    wire.mockImplementation(async (url, init) => {
      if (url === "/api/dd/analyze") { storage.present = true; storage.body = JSON.stringify([finding()]); storage.revision = '"partial"'; return new Response('{"type":"error","message":"Synthetic conflict after checkpoint"}\n'); }
      return original(url, init);
    });
    const h = harness("components/dd/DDStage5Review.tsx", context); cleanups.push(h.dispose);
    h.render(); await tick(); await nodes(h.render()).find(n => n.props.children === "Jalankan analisis")!.props.onClick();
    let tree = h.render(); expect(nodes(tree).some(n => n.props.role === "alert")).toBe(true);
    expect(nodes(tree).filter(n => n.props.f)).toHaveLength(0);
    nodes(tree).find(n => n.props.children === "Buang draft lokal dan muat ulang temuan tersimpan")!.props.onClick(); await tick();
    expect(nodes(h.render()).find(n => n.props.f?.id === "f1")!.props.f.problem).toBe("Synthetic original");
  });
  it("unmount during narrative prevents later consolidation or context dispatch", async () => {
    let resolve!: (r: Response) => void; const narrative = new Promise<Response>(r => { resolve = r; });
    const original = wire.getMockImplementation()!;
    wire.mockImplementation(async (url, init) => {
      if (url === "/api/dd/analyze") return new Response(JSON.stringify({ type: "done", findings: [finding()], revision: '"done"' }) + "\n");
      if (url === "/api/dd/narrative" && init?.method === "POST") return narrative;
      return original(url, init);
    });
    const h = harness("components/dd/DDStage5Review.tsx", context); cleanups.push(h.dispose);
    h.render(); await tick(); const running = nodes(h.render()).find(n => n.props.children === "Jalankan analisis")!.props.onClick();
    await vi.waitFor(() => expect(wire.mock.calls.some(c => c[0] === "/api/dd/narrative" && c[1]?.method === "POST")).toBe(true));
    h.dispose(); context.dispatch.mockClear(); resolve(new Response('{"type":"done","coverageNotes":["Synthetic"]}\n')); await running;
    expect(context.dispatch).not.toHaveBeenCalled();
    expect(wire.mock.calls.some(c => c[0] === "/api/dd/consolidate" && c[1]?.method === "POST")).toBe(false);
  });
});
