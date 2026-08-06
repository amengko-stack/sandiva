import { readBlobText, writeBlobText } from "@/lib/blob";
import { splitDocBlocks } from "@/lib/extract-format";
import { ddKeys } from "@/lib/dd/blob-keys";
import { snapshotBaseline } from "@/lib/dd/supplement";
import type { DDBaseline, DDEntityResult } from "@/types/dd";

/**
 * The record of what each issued report covered.
 *
 * Kept as a list per entity, oldest first, because a matter runs interim →
 * supplement → supplement → final and each supplement has to diff against the
 * report it supplements rather than merely the most recent state.
 */

export async function readBaselines(sessionId: string, entityId: string): Promise<DDBaseline[]> {
  const raw = await readBlobText(ddKeys.baselines(sessionId, entityId));
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? (parsed as DDBaseline[]) : [];
}

/** The extracted text of each document, keyed by file name. */
export async function loadContentByFile(
  sessionId: string,
  entityId: string
): Promise<Map<string, string>> {
  const combined = await readBlobText(ddKeys.extracted(sessionId, entityId));
  if (!combined) return new Map();
  return new Map(splitDocBlocks(combined).map((b) => [b.fileName, b.content]));
}

/**
 * Two baselines are the same record if they cover the same documents, the same
 * outstanding items and the same findings in the same review state.
 *
 * Exporting the same report twice — which happens, a lawyer re-downloads after a
 * typo fix elsewhere — must not stack up duplicate baselines. A later supplement
 * diffs against the LAST one, and a duplicate would silently narrow it to "nothing
 * has changed since the second export" instead of "since the report was issued".
 */
function sameRecord(a: DDBaseline, b: DDBaseline): boolean {
  const strip = (x: DDBaseline) =>
    JSON.stringify({
      documents: x.documents,
      outstandingDocIds: [...x.outstandingDocIds].sort(),
      findings: [...x.findings].sort((p, q) => p.id.localeCompare(q.id)),
      cutoffDateISO: x.cutoffDateISO,
    });
  return strip(a) === strip(b);
}

export interface RecordBaselineResult {
  baseline: DDBaseline;
  /** False when an identical record already existed and nothing was written. */
  recorded: boolean;
  total: number;
}

/**
 * Record what this report covers, so a later supplement can say what changed.
 *
 * `issuedAtISO` is passed in rather than read from the clock here: the caller knows
 * whether this is a real issue to the client or a re-export, and a pure function is
 * testable.
 */
export async function recordBaseline(args: {
  sessionId: string;
  result: DDEntityResult;
  cutoffDateISO: string;
  issuedAtISO: string;
}): Promise<RecordBaselineResult> {
  const { sessionId, result } = args;
  const entityId = result.entity.id;
  const contentByFile = await loadContentByFile(sessionId, entityId);
  const baseline = snapshotBaseline({
    entityId,
    issuedAtISO: args.issuedAtISO,
    cutoffDateISO: args.cutoffDateISO,
    classified: result.classified,
    contentByFile,
    gaps: result.gaps,
    findings: result.findings,
  });

  const existing = await readBaselines(sessionId, entityId);
  const last = existing.length > 0 ? existing[existing.length - 1] : null;
  if (last !== null && sameRecord(last, baseline)) {
    return { baseline: last, recorded: false, total: existing.length };
  }
  const next = existing.concat(baseline);
  await writeBlobText(ddKeys.baselines(sessionId, entityId), JSON.stringify(next));
  return { baseline, recorded: true, total: next.length };
}
