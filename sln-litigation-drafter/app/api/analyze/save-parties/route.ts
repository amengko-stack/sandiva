import { NextRequest, NextResponse } from "next/server";
import { writeBlobText, isValidSessionId } from "@/lib/blob";
import type { PartiesStrategy } from "@/types";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, partiesStrategy } = (await req.json()) as {
      sessionId: string;
      partiesStrategy: PartiesStrategy;
    };
    if (!isValidSessionId(sessionId) || !partiesStrategy) {
      return NextResponse.json({ error: "sessionId dan partiesStrategy wajib diisi" }, { status: 400 });
    }
    await writeBlobText(
      `sessions/${sessionId}/parties_strategy.json`,
      JSON.stringify({ ...partiesStrategy, timestamp: new Date().toISOString() })
    );
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menyimpan identitas pihak";
    console.error("[save-parties] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
