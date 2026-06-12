import { NextRequest, NextResponse } from "next/server";
import { writeBlobText } from "@/lib/blob";
import type { InterviewAnswer } from "@/types";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, answers, pihak } = (await req.json()) as {
      sessionId: string;
      answers: InterviewAnswer[];
      pihak?: string;
    };
    if (!sessionId || !answers) {
      return NextResponse.json({ error: "sessionId dan answers wajib diisi" }, { status: 400 });
    }
    await writeBlobText(
      `sessions/${sessionId}/interview.json`,
      JSON.stringify({ pihak: pihak ?? null, answers, timestamp: new Date().toISOString() })
    );
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menyimpan wawancara";
    console.error("[save-interview] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
