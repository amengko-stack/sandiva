import { randomUUID } from "crypto";
import { put } from "@vercel/blob";
import { readBlobText, writeBlobText } from "@/lib/blob";
import { normalizeLitigationRoot, isDriveIdentity, requireOutputTarget } from "@/lib/litigation-paths";
import { resolveMatterRoot, type MatterLocation } from "@/lib/litigation-sharepoint";
import type { FileEntry } from "@/types";

export const LITIGATION_DENIAL = { code: "LITIGATION_SCOPE_DENIED", error: "Akses matter ditolak. Mulai sesi terdaftar atau gunakan dokumen dari matter sesi ini." };
export class LitigationScopeError extends Error { constructor() { super(LITIGATION_DENIAL.error); } }
export function litigationDenied() { return Response.json(LITIGATION_DENIAL, { status: 403 }); }
const validId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const validResourceId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9!_-]+$/.test(id);
export const registrationKey = (id: string) => `sessions/${id}/litigation-registration.json`;
const manifestKey = (id: string) => `sessions/${id}/litigation-manifest.json`;
export interface LitigationRegistration extends MatterLocation { version: 1; status: "active"; sessionId: string; root: string; createdAt: string }
const REGISTRATION_FIELDS = ["version", "status", "sessionId", "root", "driveId", "itemId", "createdAt"] as const;

// Persisted JSON is an authorization boundary. Validate every raw runtime type
// before normalization so malformed values can never acquire authority through
// template-string, Date or path coercion.
export function parseLitigationSessionAuthority(value: unknown): LitigationRegistration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== REGISTRATION_FIELDS.length ||
      !REGISTRATION_FIELDS.every((field) => keys.includes(field))) return null;

  const { version, status, sessionId, root, driveId, itemId, createdAt } = record;
  if (version !== 1 || status !== "active" ||
      typeof sessionId !== "string" || sessionId.trim() === "" ||
      typeof root !== "string" || root.trim() === "" ||
      typeof driveId !== "string" || driveId.trim() === "" ||
      typeof itemId !== "string" || itemId.trim() === "" ||
      typeof createdAt !== "string" || createdAt.trim() === "") return null;

  if (!validId(sessionId) || !validResourceId(driveId) || !validResourceId(itemId)) return null;
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== createdAt) return null;
  try {
    if (normalizeLitigationRoot(root) !== root) return null;
  } catch {
    return null;
  }
  return { version: 1, status: "active", sessionId, root, driveId, itemId, createdAt };
}

// No ordinary route writes this record. Create-only storage prevents collision
// or double-submit from overwriting a different binding. Failed creation never
// returns an identifier. Manifest refresh is separate and cannot resurrect it.
export async function createLitigationSession(folderPath: unknown): Promise<LitigationRegistration> {
  const root = normalizeLitigationRoot(folderPath);
  const resolved = await resolveMatterRoot(root);
  if (!validResourceId(resolved.driveId) || !validResourceId(resolved.itemId)) throw new LitigationScopeError();
  const sessionId = randomUUID();
  const registration: LitigationRegistration = { version: 1, status: "active", sessionId, root, ...resolved, createdAt: new Date().toISOString() };
  await put(`litigation-memory/${registrationKey(sessionId)}`, JSON.stringify(registration), {
    access: "private", token: process.env.BLOB_READ_WRITE_TOKEN, addRandomSuffix: false, allowOverwrite: false,
  });
  return registration;
}

async function loadRegistration(id: unknown): Promise<LitigationRegistration> {
  if (!validId(id)) throw new LitigationScopeError();
  const raw = await readBlobText(registrationKey(id));
  if (!raw) throw new LitigationScopeError();
  const r = parseLitigationSessionAuthority(JSON.parse(raw));
  if (!r || r.sessionId !== id) throw new LitigationScopeError();
  return r;
}

function exactFilePath(path: unknown, r: LitigationRegistration): string {
  if (isDriveIdentity(path)) {
    if (path.split(":")[1] !== r.driveId) throw new LitigationScopeError();
    return path;
  }
  const normalized = normalizeLitigationRoot(path);
  // Site-path identities must come from a successful server listing too.
  // Sharing tokens are opaque roots, never a textual descendant namespace.
  if (r.root.includes("/:f:/") || !normalized.startsWith(`${r.root}/`)) throw new LitigationScopeError();
  return normalized;
}
type SubmittedFile = { path?: unknown; id?: unknown; name?: unknown };
export async function authorizeLitigation(id: unknown, targets: {
  root?: unknown; files?: unknown; filename?: unknown; folders?: readonly string[];
} = {}): Promise<LitigationRegistration> {
  try {
    const r = await loadRegistration(id);
    if (Object.prototype.hasOwnProperty.call(targets, "root") && normalizeLitigationRoot(targets.root) !== r.root) throw new LitigationScopeError();
    if (targets.folders) requireOutputTarget(targets.filename, targets.folders);
    if (Object.prototype.hasOwnProperty.call(targets, "files")) {
      if (!Array.isArray(targets.files) || targets.files.length === 0) throw new LitigationScopeError();
      const raw = await readBlobText(manifestKey(r.sessionId));
      if (!raw) throw new LitigationScopeError();
      const manifest = JSON.parse(raw) as { version: number; sessionId: string; root: string; files: FileEntry[] };
      if (manifest.version !== 1 || manifest.sessionId !== r.sessionId || manifest.root !== r.root || !Array.isArray(manifest.files)) throw new LitigationScopeError();
      const byPath = new Map<string, FileEntry>();
      for (const f of manifest.files) {
        if (!f || typeof f.id !== "string" || typeof f.name !== "string") throw new LitigationScopeError();
        const path = exactFilePath(f.path, r);
        if (byPath.has(path)) throw new LitigationScopeError();
        byPath.set(path, f);
      }
      // Complete this loop before ANY caller reads work products or starts SSE.
      for (const candidate of targets.files as SubmittedFile[]) {
        if (!candidate || typeof candidate !== "object") throw new LitigationScopeError();
        const path = exactFilePath(candidate.path, r);
        const allowed = byPath.get(path);
        if (!allowed || candidate.path !== allowed.path || (candidate.id !== undefined && candidate.id !== allowed.id) || (candidate.name !== undefined && candidate.name !== allowed.name)) throw new LitigationScopeError();
      }
    }
    return r;
  } catch { throw new LitigationScopeError(); }
}

export async function recordLitigationListing(r: LitigationRegistration, files: FileEntry[]): Promise<void> {
  // Re-read registration so a clear during listing cannot grant authority.
  await authorizeLitigation(r.sessionId, { root: r.root });
  for (const file of files) {
    exactFilePath(file.path, r);
    if (!file.id || !file.name) throw new LitigationScopeError();
  }
  await writeBlobText(manifestKey(r.sessionId), JSON.stringify({ version: 1, sessionId: r.sessionId, root: r.root, files }));
  // Retention is owned by whole-session cleanup (newest artifact across the
  // prefix), NOT a second timer on this record. Registry and manifest expire
  // with the session. Once registration is removed, even a late manifest write
  // is inert. No legacy reconstruction, per-process registry or sliding rebind.
}
