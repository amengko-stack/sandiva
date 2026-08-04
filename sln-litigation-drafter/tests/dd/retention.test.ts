import { describe, it, expect } from "vitest";
import {
  CACHE_TTL_MS, LITIGATION_SESSION_TTL_MS, ddSessionTtlMs, planSessionDeletions,
  sessionIdFromKey,
} from "@/lib/retention";
import type { RetainableBlob } from "@/lib/retention";

// The cron deleted individual blobs older than 24h. For a DD matter that runs for
// weeks — which is the whole reason the workflow has an interim report — that both
// ends the matter early and, worse, half-destroys it: extracted_text is written
// once at ingest and never rewritten, so it is reaped on day two while findings
// written from it survive. The grounding check reads that text, so every quote
// would come back "source_missing" and every finding would print as unverified.

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

const blob = (pathname: string, ageDays: number): RetainableBlob => ({
  pathname,
  url: `https://blob.example/${pathname}`,
  uploadedAt: daysAgo(ageDays),
});

describe("sessionIdFromKey", () => {
  it("reads the session id from a DD key and a litigation key alike", () => {
    expect(sessionIdFromKey("litigation-memory/sessions/abc123/dd/transaction.json")).toBe("abc123");
    expect(sessionIdFromKey("litigation-memory/sessions/abc123/draft.json")).toBe("abc123");
    expect(sessionIdFromKey("sessions/abc123/dd/entities/e1/findings.json")).toBe("abc123");
  });

  // Returning null keeps the key. Storage for an orphan is cheap; deleting a key
  // whose layout we misread is not.
  it("returns null rather than guessing for anything that is not session data", () => {
    expect(sessionIdFromKey("litigation-memory/cache/sha256-deadbeef.json")).toBeNull();
    expect(sessionIdFromKey("litigation-memory/conventions.json")).toBeNull();
    expect(sessionIdFromKey("sessions/")).toBeNull();
  });
});

describe("ddSessionTtlMs", () => {
  it("defaults to 90 days", () => {
    expect(ddSessionTtlMs({})).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("honours an explicit period", () => {
    expect(ddSessionTtlMs({ DD_SESSION_RETENTION_DAYS: "30" })).toBe(30 * 24 * 60 * 60 * 1000);
  });

  // A typo must not be able to shorten retention on live client work.
  it("falls back to the default for nonsense instead of reaping early", () => {
    for (const v of ["0", "-5", "abc", "", " "]) {
      expect(ddSessionTtlMs({ DD_SESSION_RETENTION_DAYS: v }), v).toBe(90 * 24 * 60 * 60 * 1000);
    }
  });

  it("caps an absurd period so storage cannot grow without bound", () => {
    expect(ddSessionTtlMs({ DD_SESSION_RETENTION_DAYS: "999999" })).toBe(3650 * 24 * 60 * 60 * 1000);
  });
});

describe("planSessionDeletions", () => {
  it("keeps a DD session whose oldest blob is long past 24 hours", () => {
    const plan = planSessionDeletions(
      [
        blob("litigation-memory/sessions/s1/dd/entities/e1/extracted_text.json", 6),
        blob("litigation-memory/sessions/s1/dd/entities/e1/findings.json", 1),
      ],
      NOW
    );
    expect(plan.urls).toEqual([]);
    expect(plan.kept).toBe(1);
  });

  // The defect that mattered: the ingest artefact is old, the session is not.
  it("never deletes part of a session, only the whole of it", () => {
    const plan = planSessionDeletions(
      [
        blob("litigation-memory/sessions/s1/dd/entities/e1/extracted_text.json", 40),
        blob("litigation-memory/sessions/s1/dd/entities/e1/findings.json", 0),
      ],
      NOW
    );
    expect(plan.urls).toEqual([]);
  });

  it("deletes a DD session that has been idle past its period, and all of its keys", () => {
    const plan = planSessionDeletions(
      [
        blob("litigation-memory/sessions/s1/dd/transaction.json", 200),
        blob("litigation-memory/sessions/s1/dd/entities/e1/findings.json", 95),
      ],
      NOW
    );
    expect(plan.urls).toHaveLength(2);
    expect(plan.sessions).toBe(1);
    expect(plan.kept).toBe(0);
  });

  it("still expires a litigation session after a day", () => {
    const plan = planSessionDeletions([blob("litigation-memory/sessions/s2/draft.json", 2)], NOW);
    expect(plan.urls).toHaveLength(1);
    expect(LITIGATION_SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("keeps a litigation session still being worked on", () => {
    const plan = planSessionDeletions(
      [
        blob("litigation-memory/sessions/s2/draft.json", 2),
        blob("litigation-memory/sessions/s2/draft_v2.json", 0),
      ],
      NOW
    );
    expect(plan.urls).toEqual([]);
  });

  // One session id can hold both kinds of work. The longer period must win, or
  // adding a litigation draft to a DD matter would shorten the matter's life.
  it("treats a mixed session as due diligence", () => {
    const plan = planSessionDeletions(
      [
        blob("litigation-memory/sessions/s3/draft.json", 10),
        blob("litigation-memory/sessions/s3/dd/transaction.json", 10),
      ],
      NOW
    );
    expect(plan.urls).toEqual([]);
  });

  it("decides each session independently", () => {
    const plan = planSessionDeletions(
      [
        blob("litigation-memory/sessions/live/dd/transaction.json", 3),
        blob("litigation-memory/sessions/stale/dd/transaction.json", 120),
        blob("litigation-memory/sessions/old-lit/draft.json", 5),
      ],
      NOW
    );
    expect(plan.sessions).toBe(2);
    expect(plan.kept).toBe(1);
    expect(plan.urls.some((u) => u.includes("/live/"))).toBe(false);
    expect(plan.urls.some((u) => u.includes("/stale/"))).toBe(true);
    expect(plan.urls.some((u) => u.includes("/old-lit/"))).toBe(true);
  });

  it("leaves a key it cannot attribute to a session alone and counts it", () => {
    const plan = planSessionDeletions([blob("litigation-memory/cache/sha256-abc.json", 400)], NOW);
    expect(plan.urls).toEqual([]);
    expect(plan.unrecognised).toBe(1);
    // The cache has its own sweep, on its own period.
    expect(CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("tolerates an empty listing", () => {
    expect(planSessionDeletions([], NOW)).toEqual({ urls: [], sessions: 0, kept: 0, unrecognised: 0 });
  });

  it("respects an explicitly supplied period", () => {
    const blobs = [blob("litigation-memory/sessions/s1/dd/transaction.json", 45)];
    expect(planSessionDeletions(blobs, NOW, 30 * 24 * 60 * 60 * 1000).urls).toHaveLength(1);
    expect(planSessionDeletions(blobs, NOW, 60 * 24 * 60 * 60 * 1000).urls).toHaveLength(0);
  });
});
