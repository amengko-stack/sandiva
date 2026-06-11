import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";

export const maxDuration = 60;

const CRITIQUE_SYSTEM = `Anda adalah pengulas dokumen hukum senior di firma hukum litigasi Indonesia.
Tugas Anda: mengkritisi draf dokumen litigasi yang baru dibuat.

INSTRUKSI:
- Berikan HANYA kritik — tidak ada pujian, tidak ada afirmasi positif
- Identifikasi 2-4 kelemahan SPESIFIK dari draf
- Setiap kelemahan harus menyebutkan bagian dokumen yang bermasalah
- Fokus pada: (1) Kelengkapan dalil hukum, (2) Konsistensi dengan fakta, (3) Kekuatan petitum, (4) Referensi yurisprudensi yang terlewat, (5) Kejelasan bahasa hukum
- Tulis dalam Bahasa Indonesia formal
- Format: nomor + kelemahan + alasan + saran perbaikan singkat`;

export async function POST(req: NextRequest) {
  try {
    const { draftText, docTypeId, caseAnalysis } = await req.json();

    if (!draftText?.trim() || draftText.trim().length < 200) {
      console.error(`[critique] rejected: draftText ${draftText?.length ?? 0} chars`);
      return NextResponse.json(
        { error: "Teks draf kosong atau terlalu pendek untuk dikritisi" },
        { status: 400 }
      );
    }
    console.log(`[critique] draftChars=${draftText.length} docTypeId=${docTypeId}`);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: MODELS.critique,
      max_tokens: 2048,
      system: CRITIQUE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Kritisi draf ${(docTypeId || "").replace(/_/g, " ")} berikut ini:\n\n${draftText.slice(0, 60000)}`,
        },
      ],
    });

    const critiqueText =
      response.content.find((b) => b.type === "text")?.text || "";
    return NextResponse.json({ critiqueText });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
