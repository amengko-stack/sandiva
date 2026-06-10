import { NextRequest, NextResponse } from "next/server";
import { readFileContent } from "@/lib/sharepoint";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";

export const maxDuration = 120;

const ANALYSIS_SYSTEM = `Anda adalah analis dokumen hukum senior.
Tugas: Baca dokumen litigasi yang diberikan dan identifikasi pola gaya penulisan firma hukum ini.
Analisis meliputi: struktur dokumen, pilihan bahasa formal, cara pengorganisasian argumen, format petitum, dan konvensi penulisan yang konsisten.
Tulis dalam Bahasa Indonesia formal. Maksimum 1000 kata.`;

export async function POST(req: NextRequest) {
  let step = "parse";
  try {
    const { sharePointPath, docType } = await req.json();

    if (!sharePointPath) {
      return NextResponse.json({ error: "sharePointPath wajib diisi" }, { status: 400 });
    }

    step = "readFile";
    const fileContent = await readFileContent(sharePointPath);
    if (!fileContent || fileContent.length < 100) {
      return NextResponse.json({ error: "Tidak dapat membaca file atau file kosong" }, { status: 400 });
    }

    step = "claude";
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODELS.patterns,
      max_tokens: 1500,
      system: ANALYSIS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Analisis pola gaya penulisan dokumen ${docType} berikut ini:\n\n${fileContent.slice(0, 5000)}`,
        },
      ],
    });

    const analysis = response.content.find((b) => b.type === "text")?.text || "";

    return NextResponse.json({ analysis, previewText: fileContent.slice(0, 1000) });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error(`[analyze-sample][step=${step}]`, message, stack);
    return NextResponse.json({ error: message, step, stack }, { status: 500 });
  }
}
