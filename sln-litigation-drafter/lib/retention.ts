/**
 * Which stored session data may be deleted.
 *
 * The cleanup cron used to delete individual blobs older than 24 hours. That is
 * wrong in two ways for due diligence, and the second is worse than the first.
 *
 * 1. A DD matter runs for weeks. Documents arrive in batches as findings prompt
 *    further requests, which is why the workflow has an interim report at all. A
 *    24-hour life means the matter cannot outlive one sitting.
 *
 * 2. Deleting per blob by age partially destroys a live session. extracted_text
 *    is written once at ingest and never rewritten, so on day two it is reaped
 *    while the findings written from it remain. The report would then still list
 *    findings whose source text is gone — and since the grounding check reads that
 *    text to verify quotes, every quote would come back "source_missing" and every
 *    finding would be marked unverified. A half-deleted session is more damaging
 *    than a deleted one, because it looks like it still works.
 *
 * So retention is decided per session, from the session's last activity across all
 * its blobs, and a session is deleted whole or not at all.
 *
 * The DD period is a client-confidentiality decision, not a technical one: these
 * are the other side's documents. 90 days covers a normal matter with room for a
 * supplement round; set DD_SESSION_RETENTION_DAYS to change it.
 */

export interface RetainableBlob {
  pathname: string;
  url: string;
  uploadedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Litigation drafting is a single-sitting workflow; a day is plenty. */
export const LITIGATION_SESSION_TTL_MS = DAY_MS;

/** Extraction cache is keyed by content hash, so it is shared and cheap to keep. */
export const CACHE_TTL_MS = 7 * DAY_MS;

export function ddSessionTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.DD_SESSION_RETENTION_DAYS);
  // Reject nonsense rather than silently reaping a live matter: a bad value must
  // not be able to shorten retention.
  if (!Number.isFinite(raw) || raw < 1) return 90 * DAY_MS;
  return Math.min(raw, 3650) * DAY_MS;
}

/**
 * The session a key belongs to, or null when the key is not session data.
 *
 * Returns null rather than guessing. An unrecognised key is left in place: the
 * cost of keeping an orphan is storage, the cost of deleting the wrong thing is a
 * client's work product.
 */
export function sessionIdFromKey(pathname: string): string | null {
  const m = /(?:^|\/)sessions\/([^/]+)\//.exec(pathname);
  return m ? m[1] : null;
}

export interface RetentionPlan {
  /** Blob URLs to delete. */
  urls: string[];
  /** How many whole sessions those URLs make up. */
  sessions: number;
  /** Sessions examined and kept, for the cron's log. */
  kept: number;
  /** Keys that named no session and were therefore left alone. */
  unrecognised: number;
}

/**
 * Group session blobs and decide which whole sessions have expired.
 *
 * A session counts as due diligence when any of its keys is under `/dd/`. DD keys
 * and litigation keys can coexist under one session id, and the longer period
 * wins — mixing them must not shorten how long the DD side is kept.
 */
export function planSessionDeletions(
  blobs: RetainableBlob[],
  nowMs: number,
  ddTtlMs: number = ddSessionTtlMs()
): RetentionPlan {
  const bySession = new Map<string, RetainableBlob[]>();
  let unrecognised = 0;
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    const sid = sessionIdFromKey(b.pathname);
    if (sid === null) {
      unrecognised++;
      continue;
    }
    const group = bySession.get(sid);
    if (group === undefined) bySession.set(sid, [b]);
    else group.push(b);
  }

  const urls: string[] = [];
  let sessions = 0;
  let kept = 0;
  // forEach rather than for..of: tsconfig has no downlevelIteration, so iterating
  // a Map is a compile error (TS2802).
  bySession.forEach((group) => {
    let lastActivity = 0;
    let isDD = false;
    for (let i = 0; i < group.length; i++) {
      const t = group[i].uploadedAt.getTime();
      if (t > lastActivity) lastActivity = t;
      if (group[i].pathname.indexOf("/dd/") !== -1) isDD = true;
    }
    const ttl = isDD ? ddTtlMs : LITIGATION_SESSION_TTL_MS;
    if (nowMs - lastActivity > ttl) {
      sessions++;
      for (let i = 0; i < group.length; i++) urls.push(group[i].url);
    } else {
      kept++;
    }
  });

  return { urls, sessions, kept, unrecognised };
}
