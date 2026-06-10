import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { CaseAnalysis } from "@/types";
import { MODELS } from "@/config/models";

export const maxDuration = 30;

const client = new Anthropic();

export async function POST(req: NextRequest) {
  try {
    const { caseAnalysis } = (await req.json()) as { caseAnalysis: CaseAnalysis };
    if (!caseAnalysis) {
      return NextResponse.json({ error: "caseAnalysis wajib diisi" }, { status: 400 });
    }

    const prompt = `Berdasarkan analisis perkara berikut, hasilkan 5–8 pertanyaan spesifik untuk wawancara klien guna mengisi celah fakta.

KELEMAHAN & GAPS:
${caseAnalysis.kelemahanGaps}

IDENTITAS PIHAK:
${caseAnalysis.identitasPihak}

ANALISIS ELEMEN:
${caseAnalysis.analisisElemen}

Hasilkan pertanyaan yang spesifik, faktual, dan dapat dijawab klien. Format respons sebagai JSON array string: ["pertanyaan 1", "pertanyaan 2", ...]`;

    const message = await client.messages.create({
      model: MODELS.interview,
      max_tokens: 1000,
      system: "Anda adalah litigator senior yang mempersiapkan wawancara klien untuk mengisi celah fakta dalam analisis perkara.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("Format respons tidak valid");

    const questions: string[] = JSON.parse(jsonMatch[0]);
    return NextResponse.json({ questions });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menghasilkan pertanyaan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
