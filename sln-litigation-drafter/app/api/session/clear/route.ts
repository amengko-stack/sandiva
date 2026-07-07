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
    const { blobs } = await list({ prefix, token: process.env.BLOB_READ_WRITE_TOKEN });
    if (blobs.length > 0) {
      await del(blobs.map((b: { url: string }) => b.url), { token: process.env.BLOB_READ_WRITE_TOKEN });
    }

    return NextResponse.json({ ok: true, deleted: blobs.length });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal membersihkan sesi";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
