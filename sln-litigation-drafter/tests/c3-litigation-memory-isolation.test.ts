import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Exercise the real C-1 authority, memory loaders/writers and route prompt
// construction. Only external storage, SharePoint and model boundaries are
// replaced. Assertions are on persisted bytes and exact model request content,
// never on the existence of a mock call alone.
const io = vi.hoisted(() => ({
  bytes: new Map<string, string>(),
  modelRequests: [] as Array<Record<string, unknown>>,
  resolveMatterRoot: vi.fn(),
  listMatterFiles: vi.fn(),
  readFileContent: vi.fn(),
  get: vi.fn(), put: vi.fn(), del: vi.fn(), list: vi.fn(),
  stream: vi.fn(), create: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ get: io.get, put: io.put, del: io.del, list: io.list }));
vi.mock("@/lib/litigation-sharepoint", () => ({
  resolveMatterRoot: io.resolveMatterRoot,
  listMatterFiles: io.listMatterFiles,
}));
vi.mock("@/lib/sharepoint", () => ({
  listMatterFiles: io.listMatterFiles,
  readFileContent: io.readFileContent,
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: io.stream, create: io.create };
  },
}));

import { POST as register } from "@/app/api/session/register/route";
import { POST as listing } from "@/app/api/sharepoint/list-files/route";
import { POST as analyze } from "@/app/api/analyze/route";
import { POST as draft } from "@/app/api/draft/route";
import { POST as approve } from "@/app/api/memory/approve/route";
import { POST as clear } from "@/app/api/session/clear/route";
import { POST as analyzeSample } from "@/app/api/setup/analyze-sample/route";
import { POST as saveConventions } from "@/app/api/setup/save-conventions/route";
import { POST as extractCitations } from "@/app/api/citations/extract/route";

const ROOT_A = "https://sandiva.sharepoint.com/sites/Matters/Shared%20Documents/Alpha";
const ROOT_B = "https://sandiva.sharepoint.com/sites/Matters/Shared%20Documents/Beta";
const FILE_A = { id: "a-file", name: "alpha.pdf", path: "drive:driveA:itemA", type: "pdf", size: "1 KB", selected: true, folder: "" };
const FILE_B = { id: "b-file", name: "beta.pdf", path: "drive:driveB:itemB", type: "pdf", size: "1 KB", selected: true, folder: "" };
const SENTINEL = "MATTER_A_SECRET_SENTINEL_7429";
const FIRM_SAFE = "FIRM_SAFE_GENERIC_STRUCTURE_5511";

const request = (body: object) => new NextRequest("http://localhost/api/test", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const analysis = {
  identitasPihak: "A", hubunganHukum: "B", kronologi: "C", elemenHukum: "D",
  analisisElemen: "E", buktiKunci: "F", kelemahanGaps: "G", posisiHukum: "H",
};

function draftBody(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    docTypeId: "gugatan",
    practiceAreaId: "perdata",
    claimType: "wanprestasi",
    pihak: "penggugat",
    ref: "REF-SAME-LABEL",
    caseAnalysis: analysis,
    userCorrections: "",
    ...overrides,
  };
}

function allModelText(requestValue: Record<string, unknown>): string {
  return JSON.stringify(requestValue);
}

function lastModelRequest(): Record<string, unknown> {
  const value = io.modelRequests.at(-1);
  if (!value) throw new Error("model request not captured");
  return value;
}

async function consume(response: Response): Promise<Response> {
  await response.text();
  return response;
}

async function registerMatter(root: string, driveId: string, itemId: string, file: typeof FILE_A) {
  io.resolveMatterRoot.mockResolvedValueOnce({ driveId, itemId });
  io.listMatterFiles.mockResolvedValueOnce([file]);
  const registered = await register(request({ folderPath: root }));
  expect(registered.status).toBe(200);
  const { sessionId } = await registered.json() as { sessionId: string };
  expect((await listing(request({ sessionId, folderPath: root }))).status).toBe(200);
  return sessionId;
}

async function seedAnalysisInput(sessionId: string, marker: string) {
  io.bytes.set(`litigation-memory/sessions/${sessionId}/extracted_text.json`, `${marker} `.repeat(20));
}

async function approveMatterDraft(sessionId: string, text = `${SENTINEL} approved draft content `.repeat(12)) {
  const response = await approve(request({
    sessionId,
    draftText: text,
    docType: "gugatan",
    claimType: "wanprestasi",
    ref: "MATTER-A-REF",
  }));
  expect(response.status).toBe(200);
}

function seedFirmSafeConvention() {
  io.bytes.set("litigation-memory/firm-safe/conventions.json", JSON.stringify({
    schemaVersion: 1,
    recordType: "conventions",
    scopeClass: "firm_safe",
    authoritativeMatterId: null,
    originType: "administrative_firm_safe",
    sourceClass: "firm_methodology",
    createdAt: "2026-09-04T00:00:00.000Z",
    creationRoute: "approved-administrative-import",
    workflowId: "litigation-drafter",
    workflowTaskId: "memory.firm-safe-conventions",
    sessionId: null,
    runId: "11111111-1111-4111-8111-111111111111",
    permissionAuthority: "administrative_firm_safe",
    content: FIRM_SAFE,
  }));
}

function firmSafeBase(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    scopeClass: "firm_safe",
    authoritativeMatterId: null,
    originType: "administrative_firm_safe",
    sourceClass: "firm_methodology",
    createdAt: "2026-09-04T00:00:00.000Z",
    creationRoute: "approved-administrative-import",
    workflowId: "litigation-drafter",
    workflowTaskId: "memory.firm-safe-style",
    sessionId: null,
    runId: "22222222-2222-4222-8222-222222222222",
    permissionAuthority: "administrative_firm_safe",
    ...overrides,
  };
}

async function approveWithMeta(sessionId: string, docType: string, claimType: string, ref: string, draftText: string) {
  const response = await approve(request({ sessionId, draftText, docType, claimType, ref }));
  expect(response.status).toBe(200);
}

beforeEach(() => {
  vi.clearAllMocks();
  io.bytes.clear();
  io.modelRequests.length = 0;
  io.get.mockImplementation(async (path: string) => {
    const content = io.bytes.get(path);
    if (content === undefined) return null;
    return { statusCode: 200, stream: new Response(content).body };
  });
  io.put.mockImplementation(async (path: string, body: BodyInit, options: { allowOverwrite?: boolean } = {}) => {
    if (!options.allowOverwrite && io.bytes.has(path)) throw new Error("already exists");
    const content = typeof body === "string" ? body : await new Response(body).text();
    io.bytes.set(path, content);
    return { url: path };
  });
  io.del.mockImplementation(async (paths: string | string[]) => {
    for (const path of Array.isArray(paths) ? paths : [paths]) io.bytes.delete(path);
  });
  io.list.mockImplementation(async ({ prefix }: { prefix: string }) => ({
    blobs: Array.from(io.bytes.keys()).filter((key) => key.startsWith(prefix)).map((key) => ({
      pathname: key, url: key, uploadedAt: new Date("2026-09-04T00:00:00.000Z"),
    })),
  }));
  io.readFileContent.mockResolvedValue("Matter sample text. ".repeat(30));
  io.create.mockResolvedValue({ content: [{ type: "text", text: "Analisis gaya" }] });
  io.stream.mockImplementation((args: Record<string, unknown>) => {
    io.modelRequests.push(args);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "DRAFT_OK" } };
      },
      async finalMessage() {
        return {
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: JSON.stringify(analysis) }],
        };
      },
    };
  });
});

describe("C-3 canonical fixtures A-F", () => {
  it("A — same matter approved draft reuse: a valid Matter A approval is stored under A and reused only after A authorization", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    await approveMatterDraft(sessionA);

    expect(Array.from(io.bytes.keys()).some((key) => /^litigation-memory\/matter-memory\/[a-f0-9]{64}\//.test(key))).toBe(true);
    expect(Array.from(io.bytes.keys()).some((key) => key === "litigation-memory/style_examples/index.json")).toBe(false);

    const response = await draft(request(draftBody(sessionA)));
    expect((await consume(response)).status).toBe(200);
    expect(allModelText(lastModelRequest())).toContain(SENTINEL);
  });

  it("B — cross-matter same doc type: Matter B receives zero A text even with the exact same docType and claimType", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await approveMatterDraft(sessionA);

    const response = await draft(request(draftBody(sessionB)));
    expect((await consume(response)).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(SENTINEL);
  });

  it("C — label manipulation: B cannot select A memory using A's ref, document type, claim type or party label", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await approveMatterDraft(sessionA);

    const response = await draft(request(draftBody(sessionB, {
      ref: "MATTER-A-REF", docTypeId: "gugatan", claimType: "wanprestasi", pihak: "penggugat",
    })));
    expect((await consume(response)).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(SENTINEL);
  });

  it("D — case-pattern leakage: a note extracted from A's draft is absent from B's Stage 3 prompt", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await approveMatterDraft(sessionA, `${SENTINEL} case pattern line long enough to be selected for pattern extraction and reuse.`);
    await seedAnalysisInput(sessionB, "B evidence");

    expect((await analyze(request({ sessionId: sessionB, docTypeId: "gugatan", practiceAreaId: "perdata", claimType: "wanprestasi" }))).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(SENTINEL);
  });

  it("E — style-example leakage: complete A approved style text is absent from B's Stage 4 system prompt", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await approveMatterDraft(sessionA);

    const response = await draft(request(draftBody(sessionB)));
    expect((await consume(response)).status).toBe(200);
    expect(String(lastModelRequest().system ?? "")).not.toContain(SENTINEL);
  });

  it("F — explicit firm-safe convention: validated generic methodology is available to both A and B", async () => {
    seedFirmSafeConvention();
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await seedAnalysisInput(sessionA, "A evidence");
    await seedAnalysisInput(sessionB, "B evidence");

    expect((await analyze(request({ sessionId: sessionA, docTypeId: "gugatan", practiceAreaId: "perdata", claimType: "wanprestasi" }))).status).toBe(200);
    expect(allModelText(lastModelRequest())).toContain(FIRM_SAFE);
    expect((await analyze(request({ sessionId: sessionB, docTypeId: "gugatan", practiceAreaId: "perdata", claimType: "wanprestasi" }))).status).toBe(200);
    expect(allModelText(lastModelRequest())).toContain(FIRM_SAFE);
  });
});

describe("C-3 canonical fixtures G-V", () => {
  it("G — legacy style index: unclassified global style entries remain stored but are excluded", async () => {
    const legacy = "LEGACY_GLOBAL_STYLE_SENTINEL_9001";
    io.bytes.set("litigation-memory/style_examples/index.json", JSON.stringify([{ path: "style_examples/legacy.txt", type: "gugatan", claimType: "wanprestasi", label: "legacy" }]));
    io.bytes.set("litigation-memory/style_examples/legacy.txt", legacy.repeat(20));
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);

    const response = await draft(request(draftBody(sessionB)));
    expect((await consume(response)).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(legacy);
    expect(io.bytes.get("litigation-memory/style_examples/legacy.txt")).toContain(legacy);
  });

  it("H — legacy case patterns: unclassified global pattern notes are excluded", async () => {
    const legacy = "LEGACY_GLOBAL_PATTERN_SENTINEL_9002";
    io.bytes.set("litigation-memory/case_patterns.json", JSON.stringify({ totalDrafts: 1, patterns: [{ docType: "gugatan", claimType: "wanprestasi", note: legacy, date: "2026-09-01" }] }));
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await seedAnalysisInput(sessionB, "B evidence");

    expect((await analyze(request({ sessionId: sessionB, docTypeId: "gugatan", practiceAreaId: "perdata", claimType: "wanprestasi" }))).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(legacy);
  });

  it("I — legacy firm conventions: an unclassified global convention is excluded until rebuilt through an approved path", async () => {
    const legacy = "LEGACY_GLOBAL_CONVENTION_SENTINEL_9003";
    io.bytes.set("litigation-memory/firm_conventions.md", legacy);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await seedAnalysisInput(sessionB, "B evidence");

    expect((await analyze(request({ sessionId: sessionB, docTypeId: "gugatan", practiceAreaId: "perdata", claimType: "wanprestasi" }))).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(legacy);
  });

  it("J — invalid session read: a syntactically valid unregistered UUID performs no memory read or model call", async () => {
    const unknown = "33333333-3333-4333-8333-333333333333";
    const responses = [
      await analyze(request({ sessionId: unknown, docTypeId: "gugatan", practiceAreaId: "perdata", claimType: "wanprestasi" })),
      await draft(request(draftBody(unknown))),
      await extractCitations(request({ sessionId: unknown, draftText: "Pasal 1" })),
    ];
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(await responses[0].json()).toEqual({ code: "LITIGATION_SCOPE_DENIED", error: "Akses matter ditolak. Mulai sesi terdaftar atau gunakan dokumen dari matter sesi ini." });
    expect(io.get.mock.calls.map(([key]) => key)).toEqual(Array(3).fill(`litigation-memory/sessions/${unknown}/litigation-registration.json`));
    expect(io.modelRequests).toHaveLength(0);
  });

  it("K — invalid session write: an unregistered UUID creates zero protected memory bytes", async () => {
    const before = Array.from(io.bytes);
    const unknown = "44444444-4444-4444-8444-444444444444";
    const responses = [
      await approve(request({ sessionId: unknown, draftText: SENTINEL.repeat(10), docType: "gugatan", claimType: "wanprestasi", ref: "forged" })),
      await saveConventions(request({ sessionId: unknown, samples: {}, generalRefinements: "unsafe" })),
      await analyzeSample(request({ sessionId: unknown, sharePointPath: FILE_A.path, docType: "gugatan", claimType: "wanprestasi" })),
    ];
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(Array.from(io.bytes)).toEqual(before);
    expect(io.put).not.toHaveBeenCalled();
    expect(io.create).not.toHaveBeenCalled();
    expect(io.readFileContent).not.toHaveBeenCalled();
  });

  it("L — cleared session: revocation blocks both new reads and writes while leaving durable matter memory inert", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    await approveMatterDraft(sessionA);
    const durableBefore = Array.from(io.bytes).filter(([key]) => key.includes("/matter-memory/"));
    expect((await clear(request({ sessionId: sessionA }))).status).toBe(200);
    vi.clearAllMocks();

    expect((await draft(request(draftBody(sessionA)))).status).toBe(403);
    expect((await approve(request({ sessionId: sessionA, draftText: SENTINEL, docType: "gugatan", claimType: "wanprestasi", ref: "A" }))).status).toBe(403);
    expect(Array.from(io.bytes).filter(([key]) => key.includes("/matter-memory/"))).toEqual(durableBefore);
    expect(io.modelRequests).toHaveLength(0);
  });

  it("M — forged ref: a valid A session carrying B labels still resolves only A memory", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    await approveMatterDraft(sessionA);
    const response = await draft(request(draftBody(sessionA, { ref: "MATTER-B-FORGED-REF", authoritativeMatterId: "rootB" })));
    expect((await consume(response)).status).toBe(200);
    expect(allModelText(lastModelRequest())).toContain(SENTINEL);
  });

  it("N — forged browser state: local/session storage values in the request cannot redirect B to A", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await approveMatterDraft(sessionA);
    const response = await draft(request(draftBody(sessionB, {
      localStorage: { sessionId: sessionA, matterId: "rootA" },
      sessionStorage: { sessionId: sessionA, ref: "MATTER-A-REF" },
    })));
    expect((await consume(response)).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(SENTINEL);
  });

  it("O — traversal/prefix collision: unsafe record IDs and client matter identifiers are inert and never read", async () => {
    const malicious = "TRAVERSAL_MEMORY_SENTINEL_9004";
    io.bytes.set("litigation-memory/firm-safe/style_examples/index.json", JSON.stringify({
      ...firmSafeBase({ recordType: "style_index" }),
      entries: [{ recordId: "../matter-memory/secret", type: "gugatan", claimType: "wanprestasi", label: "bad", source: "firm_safe", createdAt: "2026-09-04T00:00:00.000Z" }],
    }));
    io.bytes.set("litigation-memory/matter-memory/secret", malicious);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    const response = await draft(request(draftBody(sessionB, { authoritativeMatterId: "../secret", matterRoot: `${ROOT_A}-Collision` })));
    expect((await consume(response)).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(malicious);
    expect(io.get.mock.calls.map(([key]) => String(key))).not.toContain("litigation-memory/firm-safe/style_examples/../matter-memory/secret.json");
  });

  it("P — captured Stage 3 prompt isolation: B has zero A marker while A retains legitimate same-matter reuse", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await approveMatterDraft(sessionA);
    await seedAnalysisInput(sessionA, "A evidence");
    await seedAnalysisInput(sessionB, "B evidence");

    expect((await analyze(request({ sessionId: sessionB, docTypeId: "gugatan", practiceAreaId: "perdata", claimType: "wanprestasi" }))).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(SENTINEL);
    expect((await analyze(request({ sessionId: sessionA, docTypeId: "gugatan", practiceAreaId: "perdata", claimType: "wanprestasi" }))).status).toBe(200);
    expect(allModelText(lastModelRequest())).toContain(SENTINEL);
  });

  it("Q — captured Stage 4 system prompt isolation: B has zero A marker while A retains legitimate same-matter reuse", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    await approveMatterDraft(sessionA);

    expect((await consume(await draft(request(draftBody(sessionB))))).status).toBe(200);
    expect(String(lastModelRequest().system ?? "")).not.toContain(SENTINEL);
    expect((await consume(await draft(request(draftBody(sessionA))))).status).toBe(200);
    expect(String(lastModelRequest().system ?? "")).toContain(SENTINEL);
  });

  it("R — unsafe setup sample: raw and derived real-client setup material stays in A and never becomes global or enters B", async () => {
    const rawMarker = "MATTER_A_SETUP_RAW_SENTINEL_9005";
    const derivedMarker = "MATTER_A_SETUP_DERIVED_SENTINEL_9006";
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    io.readFileContent.mockResolvedValue(`${rawMarker} `.repeat(30));
    io.create.mockResolvedValueOnce({ content: [{ type: "text", text: derivedMarker }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: `${derivedMarker} conventions` }] });
    const sampleResponse = await analyzeSample(request({ sessionId: sessionA, sharePointPath: FILE_A.path, docType: "gugatan", claimType: "wanprestasi" }));
    expect(sampleResponse.status).toBe(200);
    const sampleResult = await sampleResponse.json() as { analysis: string };
    expect((await saveConventions(request({ sessionId: sessionA, samples: { gugatan: { analysis: sampleResult.analysis, refinements: "" } }, generalRefinements: "" }))).status).toBe(200);

    expect(Array.from(io.bytes.keys()).some((key) => key === "litigation-memory/firm_conventions.md" || key.startsWith("litigation-memory/style_examples/"))).toBe(false);
    expect((await consume(await draft(request(draftBody(sessionB))))).status).toBe(200);
    expect(allModelText(lastModelRequest())).not.toContain(rawMarker);
    expect(allModelText(lastModelRequest())).not.toContain(derivedMarker);
    expect((await consume(await draft(request(draftBody(sessionA))))).status).toBe(200);
    expect(allModelText(lastModelRequest())).toContain(rawMarker);
    expect(allModelText(lastModelRequest())).toContain(derivedMarker);
  });

  it("S — provenance fields: new matter records persist complete scope, source, origin, schema and run/session correlation", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    await approveMatterDraft(sessionA);
    const records = Array.from(io.bytes.entries())
      .filter(([key]) => key.includes("/matter-memory/"))
      .map(([, raw]) => JSON.parse(raw) as Record<string, unknown>);
    expect(records.length).toBeGreaterThanOrEqual(3);
    for (const record of records) {
      expect(record).toMatchObject({
        schemaVersion: 1,
        scopeClass: "matter",
        sourceClass: "client_matter",
        sessionId: sessionA,
        permissionAuthority: "c1_server_session",
        workflowId: "litigation-drafter",
      });
      expect(record.authoritativeMatterId).toMatch(/^[a-f0-9]{64}$/);
      expect(record.originType).toBe("approved_draft");
      expect(record.createdAt).toMatch(/^2026-/);
      expect(record.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(String(record.creationRoute)).toBe("/api/memory/approve");
    }
  });

  it("T — C-1 regression: immutable root authority still rejects rebind and remains usable for its original matter", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const registrationKey = `litigation-memory/sessions/${sessionA}/litigation-registration.json`;
    const original = io.bytes.get(registrationKey);
    const denied = await listing(request({ sessionId: sessionA, folderPath: ROOT_B }));
    expect(denied.status).toBe(403);
    expect(io.bytes.get(registrationKey)).toBe(original);
    expect((await consume(await draft(request(draftBody(sessionA))))).status).toBe(200);
  });

  it("U — valid same-matter ranking: exact docType+claimType ranks before same-type and recent unrelated examples after scope filtering", async () => {
    const exact = "EXACT_RANK_SENTINEL_9007 ".repeat(12);
    const sameType = "SAME_TYPE_RANK_SENTINEL_9008 ".repeat(12);
    const unrelated = "UNRELATED_RANK_SENTINEL_9009 ".repeat(12);
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    await approveWithMeta(sessionA, "gugatan", "wanprestasi", "exact", exact);
    await approveWithMeta(sessionA, "gugatan", "pmh", "same-type", sameType);
    await approveWithMeta(sessionA, "jawaban", "wanprestasi", "unrelated", unrelated);

    expect((await consume(await draft(request(draftBody(sessionA))))).status).toBe(200);
    const system = String(lastModelRequest().system ?? "");
    expect(system.indexOf("EXACT_RANK_SENTINEL_9007")).toBeGreaterThan(-1);
    expect(system.indexOf("EXACT_RANK_SENTINEL_9007")).toBeLessThan(system.indexOf("SAME_TYPE_RANK_SENTINEL_9008"));
    expect(system.indexOf("SAME_TYPE_RANK_SENTINEL_9008")).toBeLessThan(system.indexOf("UNRELATED_RANK_SENTINEL_9009"));
  });

  it("V — no automatic promotion: approving matter content creates no firm-safe artifact", async () => {
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    await approveMatterDraft(sessionA);
    expect(Array.from(io.bytes.keys()).filter((key) => key.startsWith("litigation-memory/firm-safe/"))).toEqual([]);
    expect(JSON.stringify(Array.from(io.bytes))).not.toContain('"scopeClass":"firm_safe"');
  });
});

describe("C-3 additional protected memory consumers", () => {
  it("citation extraction uses firm-safe plus same-matter conventions and excludes foreign/legacy convention text", async () => {
    const foreign = "MATTER_A_CITATION_CONVENTION_SENTINEL_9010";
    const legacy = "LEGACY_CITATION_CONVENTION_SENTINEL_9011";
    seedFirmSafeConvention();
    io.bytes.set("litigation-memory/firm_conventions.md", legacy);
    const sessionA = await registerMatter(ROOT_A, "driveA", "rootA", FILE_A);
    const sessionB = await registerMatter(ROOT_B, "driveB", "rootB", FILE_B);
    io.create.mockResolvedValueOnce({ content: [{ type: "text", text: foreign }] });
    expect((await saveConventions(request({ sessionId: sessionA, samples: {}, generalRefinements: foreign }))).status).toBe(200);
    io.stream.mockImplementationOnce((args: Record<string, unknown>) => {
      io.modelRequests.push(args);
      return {
        async *[Symbol.asyncIterator]() {},
        async finalMessage() {
          return { stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: '{"citations":[]}' }] };
        },
      };
    });

    const response = await extractCitations(request({ sessionId: sessionB, draftText: "Pasal 1" }));
    expect(response.status).toBe(200);
    const prompt = allModelText(lastModelRequest());
    expect(prompt).toContain(FIRM_SAFE);
    expect(prompt).not.toContain(foreign);
    expect(prompt).not.toContain(legacy);
  });
});
