import { NextRequest, NextResponse } from "next/server";
import { writeBlobText } from "@/lib/blob";
import type { StructuredAssessment } from "@/types";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, assessment } = (await req.json()) as {
      sessionId: string;
      assessment: StructuredAssessment;
    };
    if (!sessionId || !assessment) {
      return NextResponse.json({ error: "sessionId dan assessment wajib diisi" }, { status: 400 });
    }
    await writeBlobText(
      `sessions/${sessionId}/strategic_assessment.json`,
      JSON.stringify({ assessment, timestamp: new Date().toISOString() })
    );
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menyimpan asesmen";
    console.error("[save-assessment] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
