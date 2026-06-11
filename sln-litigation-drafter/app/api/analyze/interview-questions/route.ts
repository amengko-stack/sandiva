import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { CaseAnalysis } from "@/types";
import { MODELS } from "@/config/models";

export const maxDuration = 60;

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
      max_tokens: 4096,
      system: "Anda adalah litigator senior yang mempersiapkan wawancara klien untuk mengisi celah fakta dalam analisis perkara.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    console.log(
      `[interview] stop_reason=${message.stop_reason} rawLen=${text.length} ` +
      `head=${JSON.stringify(text.slice(0, 150))} tail=${JSON.stringify(text.slice(-150))}`
    );

    let questions: string[] | null = null;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        questions = JSON.parse(jsonMatch[0]) as string[];
      } catch (e) {
        console.error("[interview] array parse failed:", e instanceof Error ? e.message : e);
      }
    }
    // Truncated mid-array (no closing ]) or invalid JSON — salvage every
    // complete quoted string so the drafter still gets the finished questions.
    if (!questions) {
      const salvaged: string[] = [];
      const re = /"((?:[^"\\]|\\.)+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const q = m[1].replace(/\\"/g, '"');
        if (q.length > 15) salvaged.push(q);
      }
      if (salvaged.length >= 3) {
        console.log(`[interview] salvaged ${salvaged.length} questions from truncated/invalid response`);
        questions = salvaged;
      }
    }
    if (!questions || questions.length === 0) {
      throw new Error(
        `Format respons tidak valid (stop_reason=${message.stop_reason}). Coba lagi.`
      );
    }

    return NextResponse.json({ questions });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menghasilkan pertanyaan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
