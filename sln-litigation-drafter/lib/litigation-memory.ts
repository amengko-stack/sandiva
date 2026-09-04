import { createHash, randomUUID } from "crypto";
import { readBlobText, writeBlobText } from "@/lib/blob";
import type { LitigationRegistration } from "@/lib/litigation-session";
import type { MemoryLibrary, PatternEntry, StyleExample } from "@/types";

export const LITIGATION_MEMORY_SCHEMA_VERSION = 1 as const;
export type MemoryScopeClass = "matter" | "firm_safe";

type OriginType =
  | "approved_draft"
  | "setup_sample"
  | "setup_conventions"
  | "administrative_firm_safe";
type SourceClass = "client_matter" | "firm_methodology";
type PermissionAuthority = "c1_server_session" | "administrative_firm_safe";
type StyleSource = "setup" | "approved" | "firm_safe";

interface ProvenanceBase {
  schemaVersion: 1;
  scopeClass: MemoryScopeClass;
  authoritativeMatterId: string | null;
  originType: OriginType;
  sourceClass: SourceClass;
  createdAt: string;
  creationRoute: string;
  workflowId: "litigation-drafter";
  workflowTaskId: string;
  sessionId: string | null;
  runId: string;
  permissionAuthority: PermissionAuthority;
}

interface ConventionRecord extends ProvenanceBase {
  recordType: "conventions";
  content: string;
}

interface PatternRecord extends ProvenanceBase, PatternEntry {
  recordType: "case_pattern";
}

interface PatternCollection extends ProvenanceBase {
  recordType: "case_patterns";
  totalDrafts: number;
  patterns: PatternRecord[];
}

interface StyleIndexEntry {
  recordId: string;
  type: string;
  claimType: string;
  label: string;
  source: StyleSource;
  createdAt: string;
}

interface StyleIndex extends ProvenanceBase {
  recordType: "style_index";
  entries: StyleIndexEntry[];
}

interface StyleRecord extends ProvenanceBase {
  recordType: "style_example";
  recordId: string;
  type: string;
  claimType: string;
  label: string;
  source: StyleSource;
  content: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MATTER_ID = /^[a-f0-9]{64}$/;
const PRIMARY_EXAMPLE_CAP = 120_000;
const SECONDARY_EXAMPLE_CAP = 8_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function authoritativeMatterId(authority: LitigationRegistration): string {
  return createHash("sha256")
    .update(`c3-matter-v1\0${authority.driveId}\0${authority.itemId}`, "utf8")
    .digest("hex");
}

function namespace(scopeClass: MemoryScopeClass, matterId: string | null): string {
  if (scopeClass === "firm_safe") return "firm-safe";
  if (!matterId || !MATTER_ID.test(matterId)) throw new Error("Invalid authoritative matter identity");
  return `matter-memory/${matterId}`;
}

function expectedScope(scopeClass: MemoryScopeClass, matterId: string | null) {
  return scopeClass === "firm_safe"
    ? { authoritativeMatterId: null, sourceClass: "firm_methodology", sessionId: null, permissionAuthority: "administrative_firm_safe", originType: "administrative_firm_safe" }
    : { authoritativeMatterId: matterId, sourceClass: "client_matter", permissionAuthority: "c1_server_session" };
}

function validBase(value: unknown, scopeClass: MemoryScopeClass, matterId: string | null): value is ProvenanceBase {
  if (!isObject(value)) return false;
  const expected = expectedScope(scopeClass, matterId);
  if (value.schemaVersion !== LITIGATION_MEMORY_SCHEMA_VERSION || value.scopeClass !== scopeClass ||
      value.authoritativeMatterId !== expected.authoritativeMatterId || value.sourceClass !== expected.sourceClass ||
      value.permissionAuthority !== expected.permissionAuthority || value.workflowId !== "litigation-drafter" ||
      typeof value.workflowTaskId !== "string" || value.workflowTaskId.length === 0 ||
      typeof value.creationRoute !== "string" || value.creationRoute.length === 0 ||
      !isCanonicalIso(value.createdAt) || typeof value.runId !== "string" || !UUID.test(value.runId)) return false;
  if (scopeClass === "firm_safe") {
    return value.originType === "administrative_firm_safe" && value.sessionId === null;
  }
  return ["approved_draft", "setup_sample", "setup_conventions"].includes(String(value.originType)) &&
    typeof value.sessionId === "string" && UUID.test(value.sessionId);
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function validConvention(value: unknown, scopeClass: MemoryScopeClass, matterId: string | null): value is ConventionRecord {
  if (!validBase(value, scopeClass, matterId)) return false;
  const record = value as ProvenanceBase & Record<string, unknown>;
  return record.recordType === "conventions" && typeof record.content === "string";
}

function validPatternRecord(value: unknown, scopeClass: MemoryScopeClass, matterId: string | null): value is PatternRecord {
  if (!validBase(value, scopeClass, matterId)) return false;
  const record = value as ProvenanceBase & Record<string, unknown>;
  return record.recordType === "case_pattern" && typeof record.docType === "string" &&
    typeof record.claimType === "string" && typeof record.note === "string" && typeof record.date === "string";
}

function validPatternCollection(value: unknown, scopeClass: MemoryScopeClass, matterId: string | null): value is PatternCollection {
  if (!validBase(value, scopeClass, matterId)) return false;
  const record = value as ProvenanceBase & Record<string, unknown>;
  return record.recordType === "case_patterns" && typeof record.totalDrafts === "number" &&
    Number.isSafeInteger(record.totalDrafts) && record.totalDrafts >= 0 && Array.isArray(record.patterns) &&
    record.patterns.every((entry: unknown) => validPatternRecord(entry, scopeClass, matterId));
}

function validIndexEntry(value: unknown): value is StyleIndexEntry {
  return isObject(value) && typeof value.recordId === "string" && UUID.test(value.recordId) &&
    typeof value.type === "string" && typeof value.claimType === "string" && typeof value.label === "string" &&
    ["setup", "approved", "firm_safe"].includes(String(value.source)) && isCanonicalIso(value.createdAt);
}

function validStyleIndex(value: unknown, scopeClass: MemoryScopeClass, matterId: string | null): value is StyleIndex {
  if (!validBase(value, scopeClass, matterId)) return false;
  const record = value as ProvenanceBase & Record<string, unknown>;
  if (record.recordType !== "style_index" || !Array.isArray(record.entries) || !record.entries.every(validIndexEntry)) return false;
  const entries = record.entries as StyleIndexEntry[];
  return scopeClass === "firm_safe" ? entries.every((entry) => entry.source === "firm_safe") : entries.every((entry) => entry.source !== "firm_safe");
}

function validStyleRecord(value: unknown, scopeClass: MemoryScopeClass, matterId: string | null): value is StyleRecord {
  if (!validBase(value, scopeClass, matterId)) return false;
  const record = value as ProvenanceBase & Record<string, unknown>;
  return record.recordType === "style_example" && typeof record.recordId === "string" && UUID.test(record.recordId) &&
    typeof record.type === "string" && typeof record.claimType === "string" && typeof record.label === "string" &&
    typeof record.content === "string" && ["setup", "approved", "firm_safe"].includes(String(record.source)) &&
    (scopeClass === "firm_safe" ? record.source === "firm_safe" : record.source !== "firm_safe");
}

function matterBase(
  authority: LitigationRegistration,
  originType: Exclude<OriginType, "administrative_firm_safe">,
  creationRoute: string,
  workflowTaskId: string,
  runId: string,
  createdAt: string
): ProvenanceBase {
  return {
    schemaVersion: 1,
    scopeClass: "matter",
    authoritativeMatterId: authoritativeMatterId(authority),
    originType,
    sourceClass: "client_matter",
    createdAt,
    creationRoute,
    workflowId: "litigation-drafter",
    workflowTaskId,
    sessionId: authority.sessionId,
    runId,
    permissionAuthority: "c1_server_session",
  };
}

async function readConvention(scopeClass: MemoryScopeClass, matterId: string | null): Promise<ConventionRecord | null> {
  const value = parseJson(await readBlobText(`${namespace(scopeClass, matterId)}/conventions.json`));
  return validConvention(value, scopeClass, matterId) ? value : null;
}

async function readPatterns(scopeClass: MemoryScopeClass, matterId: string | null): Promise<PatternCollection | null> {
  const value = parseJson(await readBlobText(`${namespace(scopeClass, matterId)}/case_patterns.json`));
  return validPatternCollection(value, scopeClass, matterId) ? value : null;
}

async function readStyleIndex(scopeClass: MemoryScopeClass, matterId: string | null): Promise<StyleIndex | null> {
  const value = parseJson(await readBlobText(`${namespace(scopeClass, matterId)}/style_examples/index.json`));
  return validStyleIndex(value, scopeClass, matterId) ? value : null;
}

async function eligibleStyleEntries(matterId: string): Promise<Array<{ entry: StyleIndexEntry; scopeClass: MemoryScopeClass }>> {
  const [firmSafe, matter] = await Promise.all([
    readStyleIndex("firm_safe", null),
    readStyleIndex("matter", matterId),
  ]);
  return [
    ...(firmSafe?.entries ?? []).map((entry) => ({ entry, scopeClass: "firm_safe" as const })),
    ...(matter?.entries ?? []).map((entry) => ({ entry, scopeClass: "matter" as const })),
  ];
}

async function loadStyle(
  item: { entry: StyleIndexEntry; scopeClass: MemoryScopeClass },
  matterId: string,
  cap: number
): Promise<StyleExample | null> {
  const recordMatterId = item.scopeClass === "matter" ? matterId : null;
  const path = `${namespace(item.scopeClass, recordMatterId)}/style_examples/${item.entry.recordId}.json`;
  const value = parseJson(await readBlobText(path));
  if (!validStyleRecord(value, item.scopeClass, recordMatterId) ||
      value.recordId !== item.entry.recordId || value.type !== item.entry.type ||
      value.claimType !== item.entry.claimType || value.label !== item.entry.label ||
      value.source !== item.entry.source || value.createdAt !== item.entry.createdAt || value.content.length < 200) return null;
  return { type: value.type, claimType: value.claimType, label: value.label, content: value.content.slice(0, cap), source: value.source };
}

async function loadBase(authority: LitigationRegistration): Promise<Omit<MemoryLibrary, "styleExamples">> {
  const matterId = authoritativeMatterId(authority);
  const [safeConvention, matterConvention, safePatterns, matterPatterns] = await Promise.all([
    readConvention("firm_safe", null), readConvention("matter", matterId),
    readPatterns("firm_safe", null), readPatterns("matter", matterId),
  ]);
  const conventions = [safeConvention?.content, matterConvention?.content].filter(Boolean).join("\n\n");
  const patterns = [...(safePatterns?.patterns ?? []), ...(matterPatterns?.patterns ?? [])]
    .map(({ docType, claimType, note, date }) => ({ docType, claimType, note, date }));
  return { conventions, patterns: { totalDrafts: (safePatterns?.totalDrafts ?? 0) + (matterPatterns?.totalDrafts ?? 0), patterns } };
}

export async function loadMemoryLibrary(authority: LitigationRegistration): Promise<MemoryLibrary> {
  const matterId = authoritativeMatterId(authority);
  const [base, entries] = await Promise.all([loadBase(authority), eligibleStyleEntries(matterId)]);
  const recent = [...entries].sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt)).slice(-3);
  const loaded = await Promise.all(recent.map((item) => loadStyle(item, matterId, 3_000)));
  return { ...base, styleExamples: loaded.filter((item): item is StyleExample => item !== null) };
}

export async function loadDraftMemory(
  authority: LitigationRegistration,
  docTypeId: string,
  claimType: string | null
): Promise<MemoryLibrary> {
  const matterId = authoritativeMatterId(authority);
  const [base, entries] = await Promise.all([loadBase(authority), eligibleStyleEntries(matterId)]);
  const rank = (item: { entry: StyleIndexEntry }) => {
    const entry = item.entry;
    const matchTier = entry.type === docTypeId && (claimType == null || entry.claimType === claimType) ? 0 : entry.type === docTypeId ? 1 : 2;
    const sourceTier = entry.source === "approved" ? 1 : 0;
    return matchTier * 2 + sourceTier;
  };
  const ranked = [...entries].sort((a, b) => rank(a) - rank(b) || b.entry.createdAt.localeCompare(a.entry.createdAt)).slice(0, 3);
  const loaded = await Promise.all(ranked.map((item, index) => loadStyle(item, matterId, index === 0 ? PRIMARY_EXAMPLE_CAP : SECONDARY_EXAMPLE_CAP)));
  return { ...base, styleExamples: loaded.filter((item): item is StyleExample => item !== null) };
}

export function buildMemoryContext(memory: MemoryLibrary): string {
  let context = "";
  if (memory.conventions) context += `\n\n=== KONVENSI FIRMA SLN ===\n${memory.conventions}\n`;
  if (memory.patterns.totalDrafts > 0) {
    context += `\n=== POLA KASUS (dari ${memory.patterns.totalDrafts} draft sebelumnya) ===\n`;
    for (const pattern of memory.patterns.patterns.slice(-5)) context += `- ${pattern.docType} (${pattern.claimType}): ${pattern.note}\n`;
  }
  if (memory.styleExamples.length > 0) {
    context += "\n=== CONTOH DRAFT YANG DISETUJUI SLN ===\n";
    for (const example of memory.styleExamples) {
      context += `\n--- ${example.label} (${example.type} / ${example.claimType}) ---\n${example.content}\n`;
    }
  }
  return context;
}

export async function loadEligibleConventions(authority: LitigationRegistration): Promise<string> {
  return (await loadBase(authority)).conventions;
}

export async function saveApprovedDraft(
  authority: LitigationRegistration,
  draftText: string,
  meta: { docType: string; claimType: string; ref: string }
): Promise<void> {
  const matterId = authoritativeMatterId(authority);
  const prefix = namespace("matter", matterId);
  const now = new Date();
  const createdAt = now.toISOString();
  const date = createdAt.slice(0, 10);
  const runId = randomUUID();
  const recordId = randomUUID();
  const base = matterBase(authority, "approved_draft", "/api/memory/approve", "memory.approve-draft", runId, createdAt);
  const label = `${meta.ref} — ${date}`;
  const style: StyleRecord = { ...base, recordType: "style_example", recordId, type: meta.docType, claimType: meta.claimType, label, source: "approved", content: draftText };
  await writeBlobText(`${prefix}/style_examples/${recordId}.json`, JSON.stringify(style));

  const currentIndex = await readStyleIndex("matter", matterId);
  const entries = [...(currentIndex?.entries ?? []), { recordId, type: meta.docType, claimType: meta.claimType, label, source: "approved" as const, createdAt }];
  const setupEntries = entries.filter((entry) => entry.source === "setup");
  const approvedEntries = entries.filter((entry) => entry.source === "approved").slice(-20);
  const index: StyleIndex = { ...base, recordType: "style_index", entries: [...setupEntries, ...approvedEntries] };
  await writeBlobText(`${prefix}/style_examples/index.json`, JSON.stringify(index, null, 2));

  const existingPatterns = await readPatterns("matter", matterId);
  const note = draftText.split("\n").filter((line) => line.trim().length > 40).slice(0, 2).join(" | ").slice(0, 200);
  const pattern: PatternRecord = { ...base, recordType: "case_pattern", docType: meta.docType, claimType: meta.claimType, note, date };
  const patterns: PatternCollection = {
    ...base,
    recordType: "case_patterns",
    totalDrafts: (existingPatterns?.totalDrafts ?? 0) + 1,
    patterns: [...(existingPatterns?.patterns ?? []), pattern].slice(-50),
  };
  await writeBlobText(`${prefix}/case_patterns.json`, JSON.stringify(patterns, null, 2));
}

export async function saveSetupSample(
  authority: LitigationRegistration,
  docType: string,
  claimType: string,
  content: string
): Promise<void> {
  const matterId = authoritativeMatterId(authority);
  const prefix = namespace("matter", matterId);
  const createdAt = new Date().toISOString();
  const runId = randomUUID();
  const recordId = randomUUID();
  const normalizedClaimType = claimType || "umum";
  const base = matterBase(authority, "setup_sample", "/api/setup/analyze-sample", "memory.setup-sample", runId, createdAt);
  const label = `Sampel matter — ${docType}/${normalizedClaimType} (${createdAt.slice(0, 10)})`;
  const style: StyleRecord = { ...base, recordType: "style_example", recordId, type: docType, claimType: normalizedClaimType, label, source: "setup", content };
  await writeBlobText(`${prefix}/style_examples/${recordId}.json`, JSON.stringify(style));
  const current = await readStyleIndex("matter", matterId);
  const entries = (current?.entries ?? []).filter((entry) => !(entry.source === "setup" && entry.type === docType && entry.claimType === normalizedClaimType));
  entries.push({ recordId, type: docType, claimType: normalizedClaimType, label, source: "setup", createdAt });
  const index: StyleIndex = { ...base, recordType: "style_index", entries };
  await writeBlobText(`${prefix}/style_examples/index.json`, JSON.stringify(index, null, 2));
}

export async function loadMatterConventions(authority: LitigationRegistration): Promise<string | null> {
  return (await readConvention("matter", authoritativeMatterId(authority)))?.content ?? null;
}

export async function saveMatterConventions(authority: LitigationRegistration, content: string): Promise<void> {
  const createdAt = new Date().toISOString();
  const base = matterBase(authority, "setup_conventions", "/api/setup/save-conventions", "memory.setup-conventions", randomUUID(), createdAt);
  const record: ConventionRecord = { ...base, recordType: "conventions", content };
  await writeBlobText(`${namespace("matter", authoritativeMatterId(authority))}/conventions.json`, JSON.stringify(record, null, 2));
}
