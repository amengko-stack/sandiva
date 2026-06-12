import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { CaseAnalysis } from "@/types";
import { MODELS } from "@/config/models";

export const maxDuration = 60;

const client = new Anthropic();

export async function POST(req: NextRequest) {
  try {
    const { caseAnalysis, docTypeId, claimType, pihak, kronologi } = (await req.json()) as {
      caseAnalysis: CaseAnalysis;
      docTypeId?: string;
      claimType?: string | null;
      pihak?: string;
      kronologi?: string;
    };
    if (!caseAnalysis) {
      return NextResponse.json({ error: "caseAnalysis wajib diisi" }, { status: 400 });
    }

    const pihakLabel =
      pihak === "tergugat" ? "Tergugat / Termohon" : "Penggugat / Pemohon";

    const prompt = `Anda mempersiapkan WAWANCARA STRATEGIS dengan klien. Drafter mewakili pihak ${pihakLabel} dalam perkara ${(docTypeId || "").replace(/_/g, " ")}${claimType ? ` (${claimType.replace(/_/g, " ")})` : ""}.

Hasilkan 5–8 pertanyaan wawancara yang STRATEGIS dan SPESIFIK terhadap posisi ${pihakLabel}: gali fakta yang memperkuat posisi pihak kami, antisipasi serangan pihak lawan, dan isi celah bukti yang teridentifikasi.

KRONOLOGI YANG SUDAH DIKONFIRMASI DRAFTER:
${(kronologi || caseAnalysis.kronologi || "").slice(0, 4000)}

KELEMAHAN & GAPS:
${caseAnalysis.kelemahanGaps}

IDENTITAS PIHAK:
${caseAnalysis.identitasPihak}

ANALISIS ELEMEN:
${caseAnalysis.analisisElemen}

Setiap pertanyaan harus spesifik, faktual, dapat dijawab klien, dan relevan dengan posisi ${pihakLabel}.
PENTING: Kembalikan HANYA JSON array of strings yang valid — tanpa markdown, tanpa pagar kode, tanpa teks lain. Contoh format: ["pertanyaan 1", "pertanyaan 2"]`;

    const message = await client.messages.create({
      model: MODELS.interview,
      max_tokens: 4096,
      system: `Anda adalah litigator senior yang mempersiapkan wawancara klien strategis. Anda mewakili pihak ${pihakLabel}. Kembalikan HANYA JSON array string yang valid.`,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    console.log(
      `[interview] stop_reason=${message.stop_reason} rawLen=${text.length} ` +
      `head=${JSON.stringify(text.slice(0, 150))} tail=${JSON.stringify(text.slice(-150))}`
    );

    let questions: string[] | null = null;
    const clean = text.replace(/```json|```/g, "").trim();
    const jsonMatch = clean.match(/\[[\s\S]*\]/);
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
