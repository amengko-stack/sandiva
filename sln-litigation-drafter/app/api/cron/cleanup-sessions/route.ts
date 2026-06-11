import { NextRequest, NextResponse } from "next/server";
import { list, del } from "@vercel/blob";
import { timingSafeEqual } from "crypto";

export const maxDuration = 60;

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;   // sessions: 24 hours
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // extraction cache: 7 days

async function deleteOlderThan(prefix: string, ttlMs: number): Promise<number> {
  const cutoff = Date.now() - ttlMs;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor });
    const stale = page.blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff);
    if (stale.length > 0) {
      await del(stale.map((b) => b.url));
      deleted += stale.length;
    }
    cursor = page.cursor;
  } while (cursor);
  return deleted;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/, "") ?? "";

  if (!cronSecret || token.length !== cronSecret.length || !timingSafeEqual(Buffer.from(token), Buffer.from(cronSecret))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Sessions older than 24h — prefix-scoped, so cache/ keys are never touched
  const sessionsDeleted = await deleteOlderThan("litigation-memory/sessions/", SESSION_TTL_MS);
  // Extraction cache older than 7 days
  const cacheDeleted = await deleteOlderThan("litigation-memory/cache/", CACHE_TTL_MS);

  return NextResponse.json({ sessionsDeleted, cacheDeleted });
}
