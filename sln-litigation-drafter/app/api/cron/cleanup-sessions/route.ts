import { NextRequest, NextResponse } from "next/server";
import { list, del } from "@vercel/blob";
import { timingSafeEqual } from "crypto";
import { CACHE_TTL_MS, planSessionDeletions } from "@/lib/retention";
import type { RetainableBlob } from "@/lib/retention";

export const maxDuration = 60;

/** del() takes a list; keep each call to a size the API is comfortable with. */
const DEL_BATCH = 100;

async function deleteUrls(urls: string[]): Promise<number> {
  for (let i = 0; i < urls.length; i += DEL_BATCH) {
    await del(urls.slice(i, i + DEL_BATCH));
  }
  return urls.length;
}

async function listAll(prefix: string): Promise<RetainableBlob[]> {
  const out: RetainableBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor });
    for (let i = 0; i < page.blobs.length; i++) {
      const b = page.blobs[i];
      out.push({ pathname: b.pathname, url: b.url, uploadedAt: b.uploadedAt });
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/** The cache is content-hashed and shared, so it stays a per-blob sweep by age. */
async function sweepCache(nowMs: number): Promise<number> {
  const stale = (await listAll("litigation-memory/cache/")).filter(
    (b) => nowMs - b.uploadedAt.getTime() > CACHE_TTL_MS
  );
  return deleteUrls(stale.map((b) => b.url));
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/, "") ?? "";

  if (!cronSecret || token.length !== cronSecret.length || !timingSafeEqual(Buffer.from(token), Buffer.from(cronSecret))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nowMs = Date.now();

  // The whole listing is gathered before anything is deleted, because one
  // session's blobs can straddle pages and retention is decided from the newest
  // blob in the session. Deciding page by page is what let a live session be
  // reaped in pieces.
  const plan = planSessionDeletions(await listAll("litigation-memory/sessions/"), nowMs);
  const sessionsDeleted = await deleteUrls(plan.urls);
  const cacheDeleted = await sweepCache(nowMs);

  return NextResponse.json({
    // Blob counts, under the original field names so anything already watching
    // this endpoint keeps working.
    sessionsDeleted,
    cacheDeleted,
    sessionsExpired: plan.sessions,
    sessionsKept: plan.kept,
    keysNotAttributedToASession: plan.unrecognised,
  });
}
