import { NextRequest, NextResponse } from "next/server";
import { writeBlobText } from "@/lib/blob";
import type { JurisprudenceEntry } from "@/types";

export async function POST(req: NextRequest) {
  try {
    const { sessionId, entries } = (await req.json()) as {
      sessionId: string;
      entries: JurisprudenceEntry[];
    };
    await writeBlobText(`sessions/${sessionId}/jurisprudence_selected.json`, JSON.stringify(entries));
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
