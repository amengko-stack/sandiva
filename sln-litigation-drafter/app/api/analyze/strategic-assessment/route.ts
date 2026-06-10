import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { CaseAnalysis, InterviewAnswer } from "@/types";
import { MODELS } from "@/config/models";

export const maxDuration = 30;

const client = new Anthropic();

export async function POST(req: NextRequest) {
  try {
    const { caseAnalysis, interviewAnswers } = (await req.json()) as {
      caseAnalysis: CaseAnalysis;
      interviewAnswers: InterviewAnswer[];
    };
    if (!caseAnalysis) {
      return NextResponse.json({ error: "caseAnalysis wajib diisi" }, { status: 400 });
    }

    const answersText = interviewAnswers
      .map((ia, i) => `${i + 1}. ${ia.question}\n   Jawaban: ${ia.answer || "(tidak dijawab)"}`)
      .join("\n\n");

    const prompt = `Buat asesmen strategis litigasi 400–600 kata berdasarkan analisis perkara dan hasil wawancara klien berikut.

POSISI HUKUM:
${caseAnalysis.posisiHukum}

ANALISIS ELEMEN:
${caseAnalysis.analisisElemen}

HASIL WAWANCARA KLIEN:
${answersText || "(tidak ada jawaban)"}

Asesmen strategis harus mencakup: (1) kekuatan posisi klien, (2) risiko utama, (3) strategi pembuktian, (4) rekomendasi tindakan prioritas.`;

    const message = await client.messages.create({
      model: MODELS.assessment,
      max_tokens: 2000,
      system: "Anda adalah litigator senior yang menulis rencana strategis litigasi berdasarkan analisis perkara dan informasi klien.",
      messages: [{ role: "user", content: prompt }],
    });

    const assessment = message.content[0].type === "text" ? message.content[0].text : "";
    return NextResponse.json({ assessment });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menghasilkan asesmen";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
