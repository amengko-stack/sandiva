import { NextRequest, NextResponse } from "next/server";
import { del, list } from "@vercel/blob";
import { isValidSessionId } from "@/lib/blob";

export async function POST(req: NextRequest) {
  try {
    const { sessionId } = await req.json();
    if (!sessionId) return NextResponse.json({ ok: true });
    if (!isValidSessionId(sessionId)) {
      return NextResponse.json({ error: "sessionId tidak valid" }, { status: 400 });
    }

    const prefix = `litigation-memory/sessions/${sessionId}/`;
    // Revoke first. A failed/partial cleanup or an in-flight manifest write
    // must never leave a usable authorization record behind.
    await del(`${prefix}litigation-registration.json`, { token: process.env.BLOB_READ_WRITE_TOKEN });
    const urls: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, token: process.env.BLOB_READ_WRITE_TOKEN });
      urls.push(...page.blobs.map((b) => b.url));
      cursor = page.cursor;
    } while (cursor);
    for (let i = 0; i < urls.length; i += 100) {
      await del(urls.slice(i, i + 100), { token: process.env.BLOB_READ_WRITE_TOKEN });
    }

    return NextResponse.json({ ok: true, deleted: urls.length });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal membersihkan sesi";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
