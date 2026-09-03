import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Keep routes and authorization real; replace only external work/storage seams.
const io = vi.hoisted(() => ({
  bytes: new Map<string, string>(),
  listMatterFiles: vi.fn(), listAiFolder: vi.fn(), writeMatterFile: vi.fn(),
  readFileContent: vi.fn(), resolveMatterRoot: vi.fn(),
  readBlobText: vi.fn(), writeBlobText: vi.fn(),
  getFileLastModified: vi.fn(), readExtractionCache: vi.fn(),
  writeExtractionCache: vi.fn(), extractWithTier: vi.fn(), formatDocBlock: vi.fn(),
  buildLitigationDocx: vi.fn(), generateInventoryPdf: vi.fn(), model: vi.fn(),
  put: vi.fn(), del: vi.fn(), list: vi.fn(), download: vi.fn(),
}));
vi.mock("@/lib/sharepoint", () => io);
vi.mock("@/lib/litigation-sharepoint", () => io);
vi.mock("@/lib/graph-client", () => io);
vi.mock("@/lib/document-normalizer", () => ({ documentNormalizer: io }));
vi.mock("@/lib/blob", () => ({
  readBlobText: io.readBlobText, writeBlobText: io.writeBlobText,
  isValidSessionId: (s: unknown) => typeof s === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(s),
}));
vi.mock("@vercel/blob", () => ({ put: io.put, del: io.del, list: io.list }));
vi.mock("@/lib/docx-builder", () => io);
vi.mock("@/lib/docx-verify", () => ({ verifyDocx: () => ({ bad: 0, illegal: 0 }) }));
vi.mock("@/lib/inventory-pdf", () => io);
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: io.model }; } }));

import { POST as listing } from "@/app/api/sharepoint/list-files/route";
import { POST as reading } from "@/app/api/sharepoint/read-files/route";
import { POST as adding } from "@/app/api/sharepoint/add-documents/route";
import { POST as ocr } from "@/app/api/sharepoint/recheck-ocr/route";
import { POST as resume } from "@/app/api/sharepoint/check-session/route";
import { POST as sample } from "@/app/api/setup/analyze-sample/route";
import { POST as draft } from "@/app/api/sharepoint-save/route";
import { POST as saving } from "@/app/api/sharepoint/save-matter-file/route";
import { POST as inventory } from "@/app/api/docx/inventory-save/route";
import { POST as register } from "@/app/api/session/register/route";
import { POST as clear } from "@/app/api/session/clear/route";
import { POST as validate } from "@/app/api/session/validate/route";
import { POST as ddListing } from "@/app/api/dd/list-files/route";
import { GET as cleanup } from "@/app/api/cron/cleanup-sessions/route";
import { planSessionDeletions } from "@/lib/retention";

const root = "https://sandiva.sharepoint.com/sites/Matters/Shared%20Documents/Alpha";
const other = "https://sandiva.sharepoint.com/sites/Matters/Shared%20Documents/Beta";
const file = { id: "file-1", name: "evidence.pdf", path: "drive:driveA:item1", type: "pdf", size: "1 KB", selected: true, folder: "" };
const req = (body: object) => new NextRequest("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) });
const routes = [
  ["list-files", listing, { folderPath: root }],
  ["read-files", reading, { folderPath: root, files: [file], appendToExisting: true }],
  ["add-documents", adding, { folderPath: root, files: [file] }],
  ["recheck-ocr", ocr, { files: [file] }],
  ["check-session", resume, { folderPath: root }],
  ["analyze-sample", sample, { sharePointPath: file.path, docType: "gugatan" }],
  ["sharepoint-save", draft, { folderPath: root, filename: "Drafts/output.docx", draftText: "Draft" }],
  ["save-matter-file", saving, { folderPath: root, filename: "AI/output.json", content: "{}" }],
  ["inventory-save", inventory, { folderPath: root }],
] as const;
const effects = [io.listMatterFiles, io.listAiFolder, io.writeMatterFile, io.readFileContent,
  io.getFileLastModified, io.readExtractionCache, io.writeExtractionCache, io.extractWithTier,
  io.formatDocBlock, io.buildLitigationDocx, io.generateInventoryPdf, io.model, io.writeBlobText, io.download];
function noEffects() {
  for (const fn of effects) expect(fn).not.toHaveBeenCalled();
  expect(io.resolveMatterRoot).not.toHaveBeenCalled();
  expect(io.put).not.toHaveBeenCalled();
  expect(io.readBlobText.mock.calls.filter(([key]) => !String(key).includes("litigation-"))).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks(); io.bytes.clear();
  io.readBlobText.mockImplementation(async (key: string) => io.bytes.get(key) ?? null);
  io.writeBlobText.mockImplementation(async (key: string, value: string) => { io.bytes.set(key, value); return key; });
  io.listMatterFiles.mockResolvedValue([file]);
  io.listAiFolder.mockResolvedValue([]);
  io.writeMatterFile.mockResolvedValue("https://example.test/output");
  io.readFileContent.mockResolvedValue("Sample text. ".repeat(30));
  io.extractWithTier.mockResolvedValue({ content: "Evidence", extractionMethod: "full" });
  io.getFileLastModified.mockResolvedValue("2026-09-01");
  io.readExtractionCache.mockResolvedValue(null);
  io.formatDocBlock.mockReturnValue("Evidence block\n");
  io.buildLitigationDocx.mockResolvedValue(Buffer.from("docx"));
  io.generateInventoryPdf.mockResolvedValue(Buffer.from("pdf"));
  io.model.mockResolvedValue({ content: [{ type: "text", text: "Analysis" }] });
  io.resolveMatterRoot.mockResolvedValue({ driveId: "driveA", itemId: "rootA" });
  io.put.mockImplementation(async (key: string, value: string, options: { allowOverwrite?: boolean }) => {
    const local = key.replace(/^litigation-memory\//, "");
    if (!options.allowOverwrite && io.bytes.has(local)) throw new Error("already exists");
    io.bytes.set(local, value); return { url: key };
  });
  io.del.mockImplementation(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) io.bytes.delete(key.replace(/^litigation-memory\//, ""));
  });
  io.list.mockImplementation(async ({ prefix }: { prefix: string }) => ({ blobs: Array.from(io.bytes.keys())
    .map((key) => `litigation-memory/${key}`).filter((key) => key.startsWith(prefix))
    .map((key) => ({ pathname: key, url: key, uploadedAt: new Date() })) }));
  vi.stubGlobal("fetch", io.download);
});

async function registered() {
  const response = await register(req({ folderPath: root }));
  expect(response.status).toBe(200);
  const { sessionId } = await response.json();
  return sessionId as string;
}
async function prepared() {
  const sessionId = await registered();
  io.listMatterFiles.mockResolvedValue([file, { ...file, id: "file-2", path: "drive:driveA:item2" }]);
  expect((await listing(req({ sessionId, folderPath: root }))).status).toBe(200);
  vi.clearAllMocks();
  return sessionId;
}

describe("C-1 canonical fixtures", () => {
  it("1. Server registration returns a valid server-issued Litigation session and stores one root.", async () => {
    const sessionId = await registered();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(io.listMatterFiles).not.toHaveBeenCalled();
    const raw = io.bytes.get(`sessions/${sessionId}/litigation-registration.json`)!;
    expect(JSON.parse(raw)).toMatchObject({ sessionId, root, driveId: "driveA", itemId: "rootA", version: 1 });
    expect(io.put).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ allowOverwrite: false, addRandomSuffix: false }));
    expect((await register(req({ sessionId: "client-chosen-id", folderPath: root }))).status).toBe(403);
    expect(io.bytes.has("sessions/client-chosen-id/litigation-registration.json")).toBe(false);
  });
  it("2. Same-root repeat is safe/idempotent.", async () => {
    const sessionId = await prepared();
    const original = io.bytes.get(`sessions/${sessionId}/litigation-registration.json`);
    const responses = await Promise.all([listing(req({ sessionId, folderPath: `${root}/` })), listing(req({ sessionId, folderPath: root.replace("%20", " ") }))]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(io.bytes.get(`sessions/${sessionId}/litigation-registration.json`)).toBe(original);
  });
  it("3. Different-root rebind fails.", async () => {
    const sessionId = await prepared();
    const before = Array.from(io.bytes);
    expect((await register(req({ sessionId, folderPath: other }))).status).toBe(403);
    expect((await listing(req({ sessionId, folderPath: other }))).status).toBe(403);
    expect(Array.from(io.bytes)).toEqual(before); noEffects();
  });
  it.each([`${root}-Holdings`, `${root}/../Beta`, `${root}/%2e%2e/Beta`, `${root}/%252e%252e/Beta`, `${root}/%2fBeta`, `${root}/%ZZ`, `${root}\\Beta`, `${root}?id=Beta`, `${root}#Beta`, root.replace("sandiva", "other"), root.replace("Matters", "Other"), root.replace("Shared%20Documents", "OtherLibrary"), "", "drive:driveA:rootA", `${root}//child`, root.toLowerCase()])("5/6/7. Conservative listing refuses adversarial root: %s", async (folderPath) => {
    const sessionId = await prepared();
    const response = await listing(req({ sessionId, folderPath }));
    expect(response.status).toBe(403); noEffects();
    expect(await response.json()).toEqual({ code: "LITIGATION_SCOPE_DENIED", error: "Akses matter ditolak. Mulai sesi terdaftar atau gunakan dokumen dari matter sesi ini." });
  });
  it("8. Server listing populates exact allowed file identities.", async () => {
    const sessionId = await prepared();
    const response = await reading(req({ sessionId, files: [file] }));
    await response.text();
    expect(response.status).toBe(200);
    expect(io.extractWithTier).toHaveBeenCalledWith(file.path, file.name, "REFERENSI");
  });
  it.each([{ ...file, id: "forged" }, { ...file, name: "secret.pdf" }, { ...file, path: "drive:driveB:item1" }, { ...file, path: "drive:driveA:item1:extra" }])("9. Forged FileEntry.id, name or path does not enter the manifest: %j", async (forged) => {
    const sessionId = await prepared(); const before = Array.from(io.bytes);
    expect((await reading(req({ sessionId, folderPath: root, files: [forged] }))).status).toBe(403);
    expect(Array.from(io.bytes)).toEqual(before); noEffects();
  });
  it.each([
    ["10. `read-files` mixed authorized/unauthorized batch is rejected atomically with zero downstream calls.", reading],
    ["11. `add-documents` mixed batch is rejected atomically and preserves prior session bytes.", adding],
    ["12. OCR mixed batch is rejected atomically.", ocr],
  ] as const)("%s", async (_name, handler) => {
    const sessionId = await prepared();
    io.bytes.set(`sessions/${sessionId}/extracted_text.json`, "prior bytes");
    const before = Array.from(io.bytes);
    const response = await handler(req({ sessionId, folderPath: root, appendToExisting: true,
      files: [file, { ...file, id: "file-2", path: "drive:driveA:item2" }, { ...file, path: "drive:driveB:secret" }] }));
    expect(response.status).toBe(403); noEffects(); expect(Array.from(io.bytes)).toEqual(before);
  });
  it("13. External OCR folder is rejected under the single-root rule.", async () => {
    const sessionId = await prepared();
    expect((await listing(req({ sessionId, folderPath: other }))).status).toBe(403);
    expect((await ocr(req({ sessionId, files: [{ ...file, path: `${other}/ocr.pdf` }] }))).status).toBe(403); noEffects();
  });
  it("14. `check-session` wrong root performs zero AI-folder listings/downloads.", async () => {
    const sessionId = await prepared();
    expect((await resume(req({ sessionId, folderPath: other }))).status).toBe(403); noEffects();
  });
  it("15. Unauthorized setup sample performs zero file-read, model or memory-write calls.", async () => {
    const sessionId = await prepared();
    expect((await sample(req({ sessionId, sharePointPath: "drive:driveB:secret", docType: "gugatan" }))).status).toBe(403); noEffects();
  });
  it.each(routes.slice(6))("16. Each of the three write routes rejects a wrong root with zero write-side effects: %s", async (_name, handler, body) => {
    const sessionId = await prepared();
    expect((await handler(req({ ...body, sessionId, folderPath: other }))).status).toBe(403); noEffects();
  });
  it.each(["Drafts/../escape.docx", "AI/../escape.json", "/Drafts/x.docx", "Other/x.docx", "Drafts/%2e%2e/x", "Drafts\\x", "Drafts/x?y", "Drafts/.", "Drafts/..", "Drafts/x/../../y"])("17. Unsafe Drafts/../ and AI/../ targets fail: %s", async (filename) => {
    const sessionId = await prepared();
    for (const handler of [draft, saving]) {
      const response = await handler(req({ sessionId, folderPath: root, filename, content: "{}", draftText: "Draft" }));
      expect(response.status).toBe(403);
    }
    noEffects();
  });
  it.each(routes)("18. All nine routes succeed on their authorized positive path: %s", async (_name, handler, body) => {
    const sessionId = await prepared();
    io.bytes.set(`sessions/${sessionId}/report.json`, JSON.stringify({ sessionId, files: [], totalChars: 0, processed: 0, skipped: 0 }));
    const response = await handler(req({ ...body, sessionId })); await response.text();
    expect(response.status).toBe(200);
    if (handler === listing) expect(io.listMatterFiles).toHaveBeenCalledOnce();
    if ([reading, adding, ocr].includes(handler)) expect(io.extractWithTier).toHaveBeenCalledOnce();
    if (handler === resume) expect(io.listAiFolder).toHaveBeenCalledOnce();
    if (handler === sample) expect(io.readFileContent).toHaveBeenCalledOnce();
    if ([draft, saving, inventory].includes(handler)) expect(io.writeMatterFile).toHaveBeenCalledOnce();
  });
  it("19. Registration/manifest retention expires with the session, not earlier or independently.", async () => {
    const sessionId = await prepared(); const now = Date.now();
    const blobs = Array.from(io.bytes.keys()).map((key) => ({ pathname: `litigation-memory/${key}`, url: `litigation-memory/${key}`, uploadedAt: new Date(now - 2 * 86400000) }));
    const report = { pathname: `litigation-memory/sessions/${sessionId}/report.json`, url: "report", uploadedAt: new Date(now) };
    expect(planSessionDeletions([...blobs, report], now).urls).toEqual([]);
    const expired = planSessionDeletions(blobs, now);
    expect(expired.urls).toHaveLength(2);
    await io.del(expired.urls); vi.clearAllMocks();
    expect((await listing(req({ sessionId, folderPath: root }))).status).toBe(403); noEffects();
  });
  it("20. C-3 global-memory behavior is unchanged and remains explicitly open.", async () => {
    const sessionId = await prepared();
    expect((await sample(req({ sessionId, sharePointPath: file.path, docType: "gugatan" }))).status).toBe(200);
    expect(io.bytes.get("style_examples/index.json")).toContain('"source": "setup"');
    expect(Array.from(io.bytes.entries()).find(([key]) => key.startsWith("style_examples/setup_gugatan_"))?.[1]).toBe("Sample text. ".repeat(30));
  });
  it("clear revokes only the named session; a late manifest refresh cannot restore it", async () => {
    const sessionId = await prepared(); const another = await registered();
    expect((await clear(req({ sessionId }))).status).toBe(200); vi.clearAllMocks();
    expect((await listing(req({ sessionId, folderPath: root }))).status).toBe(403); noEffects();
    expect((await listing(req({ sessionId: another, folderPath: root }))).status).toBe(200);
  });
  it("failed registration creates no usable authority", async () => {
    io.resolveMatterRoot.mockRejectedValueOnce(new Error("failure"));
    expect((await register(req({ folderPath: root }))).status).not.toBe(200);
    expect(io.bytes.size).toBe(0); expect(io.put).not.toHaveBeenCalled();
  });
  it.each(routes)("malformed registration fails before target access: %s", async (_name, handler, body) => {
    const sessionId = await prepared();
    io.bytes.set(`sessions/${sessionId}/litigation-registration.json`, '{"version":0}');
    expect((await handler(req({ ...body, sessionId }))).status).toBe(403); noEffects();
  });
  it.each(routes)("expired registration fails before target access: %s", async (_name, handler, body) => {
    const sessionId = await prepared();
    const key = `sessions/${sessionId}/litigation-registration.json`;
    io.bytes.set(key, JSON.stringify({ ...JSON.parse(io.bytes.get(key)!), status: "expired" }));
    expect((await handler(req({ ...body, sessionId }))).status).toBe(403); noEffects();
  });
  it("unknown UUID and missing manifest cannot gain file access", async () => {
    const sessionId = await registered(); vi.clearAllMocks();
    expect((await reading(req({ sessionId, files: [file] }))).status).toBe(403);
    expect((await listing(req({ sessionId: "22222222-2222-4222-8222-222222222222", folderPath: root }))).status).toBe(403);
    noEffects();
  });
  it("server listing replaces the manifest; client files in the listing request grant nothing", async () => {
    const sessionId = await prepared();
    io.listMatterFiles.mockResolvedValueOnce([{ ...file, id: "new", path: "drive:driveA:new" }]);
    await listing(req({ sessionId, folderPath: root, files: [file] })); vi.clearAllMocks();
    expect((await reading(req({ sessionId, files: [file] }))).status).toBe(403); noEffects();
  });
  it("exact server-produced site-path membership permits a descendant but never a prefix sibling", async () => {
    const sessionId = await registered();
    const descendant = { ...file, path: `${root}/Evidence/proof.pdf` };
    io.listMatterFiles.mockResolvedValueOnce([descendant]);
    expect((await listing(req({ sessionId, folderPath: root }))).status).toBe(200); vi.clearAllMocks();
    expect((await sample(req({ sessionId, sharePointPath: `${root}-Holdings/Evidence/proof.pdf` }))).status).toBe(403); noEffects();
    const response = await sample(req({ sessionId, sharePointPath: descendant.path, docType: "gugatan" }));
    expect(response.status).toBe(200);
    expect(io.readFileContent).toHaveBeenCalledWith(descendant.path);
  });
  it("validate resumes the registered root only and never reads work products", async () => {
    const sessionId = await prepared();
    expect(await (await validate(req({ sessionId, folderPath: root }))).json()).toEqual({ sessionId, folderPath: root });
    expect((await validate(req({ sessionId, folderPath: other }))).status).toBe(403); noEffects();
  });
  it("registered resume restores saved analysis and selection without importing artifact authority", async () => {
    const sessionId = await prepared();
    const before = Array.from(io.bytes);
    const artifacts: Record<string, object> = {
      "analysis_1.json": { analysis: { kronologi: "Saved analysis" } },
      "session_meta_1.json": { sessionId: "legacy-artifact-id", folderPath: other, docTypeId: "gugatan", practiceAreaId: "perdata", ref: "CASE-A" },
      "file_list_1.json": { files: [file] },
    };
    io.listAiFolder.mockResolvedValueOnce(Object.keys(artifacts).map((name) => ({ name, downloadUrl: `https://download.test/${name}`, lastModified: "2026-09-03T00:00:00Z" })));
    io.download.mockImplementation(async (url: string) => Response.json(artifacts[url.split("/").pop()!]));
    const response = await resume(req({ sessionId, folderPath: root }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ found: true, analysis: { kronologi: "Saved analysis" }, docTypeId: "gugatan", ref: "CASE-A", allFiles: [file], resumeAtStage: 3 });
    expect(io.listAiFolder).toHaveBeenCalledWith(expect.objectContaining({ sessionId, root, driveId: "driveA", itemId: "rootA" }));
    expect(io.download).toHaveBeenCalled();
    expect(Array.from(io.bytes)).toEqual(before); expect(io.put).not.toHaveBeenCalled(); expect(io.writeBlobText).not.toHaveBeenCalled();
  });
  it("registration persistence failure returns no usable session identifier", async () => {
    io.put.mockRejectedValueOnce(new Error("storage unavailable"));
    const response = await register(req({ folderPath: root }));
    expect(response.status).toBe(403); expect(await response.json()).not.toHaveProperty("sessionId");
    expect(io.bytes.size).toBe(0);
  });
  it("simultaneous new registrations issue distinct immutable sessions", async () => {
    const responses = await Promise.all([register(req({ folderPath: root })), register(req({ folderPath: other }))]);
    const [a, b] = await Promise.all(responses.map((response) => response.json()));
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(JSON.parse(io.bytes.get(`sessions/${a.sessionId}/litigation-registration.json`)!)).toMatchObject({ root });
    expect(JSON.parse(io.bytes.get(`sessions/${b.sessionId}/litigation-registration.json`)!)).toMatchObject({ root: other });
  });
  it("clear removes every page and revokes before a failed artifact deletion", async () => {
    const sessionId = await prepared();
    io.list.mockResolvedValueOnce({ blobs: [{ url: "first-artifact" }], cursor: "next" })
      .mockResolvedValueOnce({ blobs: [{ url: "second-artifact" }] });
    const normalDel = io.del.getMockImplementation()!;
    io.del.mockImplementationOnce(normalDel).mockRejectedValueOnce(new Error("artifact delete failed"));
    expect((await clear(req({ sessionId }))).status).toBe(500);
    expect(io.list.mock.calls.map(([options]) => options.cursor)).toEqual([undefined, "next"]);
    expect(io.bytes.has(`sessions/${sessionId}/litigation-registration.json`)).toBe(false);
    vi.clearAllMocks();
    expect((await listing(req({ sessionId, folderPath: root }))).status).toBe(403); noEffects();
  });
  it("cleanup revokes the expired registration before any session artifact deletion", async () => {
    const sessionId = await prepared();
    vi.stubEnv("CRON_SECRET", "cleanup-test");
    const keys = [`sessions/${sessionId}/report.json`, ...Array.from(io.bytes.keys())];
    io.list.mockImplementation(async ({ prefix }: { prefix: string }) => ({ blobs: keys.map((key) => `litigation-memory/${key}`)
      .filter((key) => key.startsWith(prefix)).map((key) => ({ pathname: key, url: key, uploadedAt: new Date(Date.now() - 2 * 86400000) })) }));
    const response = await cleanup(new NextRequest("http://localhost/api/cron/cleanup-sessions", { headers: { authorization: "Bearer cleanup-test" } }));
    expect(response.status).toBe(200);
    expect(io.del.mock.calls[0][0]).toEqual([`litigation-memory/sessions/${sessionId}/litigation-registration.json`]);
    vi.clearAllMocks();
    expect((await listing(req({ sessionId, folderPath: root }))).status).toBe(403); noEffects();
  });
  it("LDD discovery retains its pre-C-1 request shape and listing behavior", async () => {
    const response = await ddListing(req({ folderPath: " Matter/Entity " }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ files: [file] });
    expect(io.listMatterFiles).toHaveBeenCalledWith("Matter/Entity");
    expect(io.put).not.toHaveBeenCalled(); expect(io.readBlobText).not.toHaveBeenCalled();
  });
});

describe("C-1 canonical protected routes", () => {
  it.each(routes)("4. Missing/legacy registry fails before target access: %s", async (_name, handler, body) => {
    const response = await handler(req({ ...body, sessionId: "legacy-session-id" }));
    await response.text();
    expect(response.status).toBe(403);
    noEffects();
  });
  it.each([["read", reading], ["add", adding], ["OCR", ocr]] as const)("atomic refusal before processing two valid siblings: %s", async (_name, handler) => {
    const response = await handler(req({ sessionId: "legacy-session-id", folderPath: root,
      files: [file, { ...file, id: "file-2", path: "drive:driveA:item2" }, { ...file, path: "drive:driveB:secret" }], appendToExisting: true }));
    await response.text();
    expect(response.status).toBe(403);
    noEffects();
  });
});
