import { NextRequest, NextResponse } from "next/server";
import { list, del } from "@vercel/blob";
import { timingSafeEqual } from "crypto";

export const maxDuration = 60;

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/, "") ?? "";

  if (!cronSecret || token.length !== cronSecret.length || !timingSafeEqual(Buffer.from(token), Buffer.from(cronSecret))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const { blobs } = await list({ prefix: "litigation-memory/sessions/" });

  const stale = blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff);
  if (stale.length > 0) {
    await del(stale.map((b) => b.url));
  }

  return NextResponse.json({ deleted: stale.length });
}
