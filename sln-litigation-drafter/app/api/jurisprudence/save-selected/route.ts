import { NextRequest, NextResponse } from "next/server";
import { writeBlobText } from "@/lib/blob";
import type { JurisprudenceEntry } from "@/types";

export async function POST(req: NextRequest) {
  try {
    const { sessionId, entries } = (await req.json()) as {
      sessionId: string;
      entries: JurisprudenceEntry[];
    };
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId wajib diisi" }, { status: 400 });
    }
    await writeBlobText(
      `sessions/${sessionId}/jurisprudence_selected.json`,
      JSON.stringify(entries, null, 2)
    );
    return NextResponse.json({ saved: entries.length });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
