import { BlobPreconditionFailedError } from "@vercel/blob";
import { readVersionedBlobText, writeVersionedBlobText } from "@/lib/blob";
import { ddKeys } from "@/lib/dd/blob-keys";
import type { DDFinding, DDFindingReviewStatus } from "@/types/dd";

export const FINDINGS_CONFLICT = "Temuan telah berubah di proses lain. Review lokal belum tersimpan. Buang draft lokal dan muat ulang sebelum melanjutkan.";
export class FindingsConflict extends Error { constructor() { super(FINDINGS_CONFLICT); } }
export interface FindingsSnapshot { findings: DDFinding[]; revision: string | null }
export interface FindingReview { id: string; status: DDFindingReviewStatus; editedProblem?: string }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const status = (v: unknown): v is DDFindingReviewStatus => ["open", "accepted", "dismissed", "edited"].includes(v as string);

/** Validate the update boundary while preserving legacy optional evidence. */
export function parseStoredFindings(value: unknown, entityId: string): DDFinding[] {
  if (!Array.isArray(value)) throw new Error("Invalid stored findings");
  const ids = new Set<string>();
  for (const f of value) {
    if (!record(f) || typeof f.id !== "string" || !f.id || ids.has(f.id) || f.entityId !== entityId ||
        !status(f.status) || (f.editedProblem !== undefined && typeof f.editedProblem !== "string") ||
        typeof f.verified !== "boolean" || !["anchor", "problem", "whyItMatters", "suggestedFix"].every(k => typeof f[k] === "string")) {
      throw new Error("Invalid stored findings");
    }
    ids.add(f.id);
  }
  return value as DDFinding[];
}

export function parseReviews(value: unknown): FindingReview[] {
  if (!Array.isArray(value)) throw new Error("Invalid review payload");
  const ids = new Set<string>();
  for (const f of value) {
    if (!record(f) || Object.keys(f).some(k => !["id", "status", "editedProblem"].includes(k)) ||
        typeof f.id !== "string" || !f.id || ids.has(f.id) || !status(f.status) ||
        (f.editedProblem !== undefined && typeof f.editedProblem !== "string")) throw new Error("Invalid review payload");
    ids.add(f.id);
  }
  return value as FindingReview[];
}

export function applyReviews(findings: DDFinding[], reviews: FindingReview[]): DDFinding[] {
  const ids = new Set(findings.map(f => f.id));
  if (reviews.some(f => !ids.has(f.id))) throw new Error("Unknown finding");
  const byId = new Map(reviews.map(f => [f.id, f]));
  return findings.map(f => {
    const r = byId.get(f.id);
    return r ? { ...f, status: r.status, editedProblem: r.editedProblem } : f;
  });
}

export async function readFindings(sessionId: string, entityId: string): Promise<FindingsSnapshot> {
  const blob = await readVersionedBlobText(ddKeys.findings(sessionId, entityId));
  return blob ? { findings: parseStoredFindings(JSON.parse(blob.text), entityId), revision: blob.revision } : { findings: [], revision: null };
}

export async function writeFindings(sessionId: string, entityId: string, findings: DDFinding[], revision: string | null): Promise<string> {
  parseStoredFindings(findings, entityId);
  try {
    return await writeVersionedBlobText(ddKeys.findings(sessionId, entityId), JSON.stringify(findings), revision);
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError) throw new FindingsConflict();
    throw e;
  }
}
