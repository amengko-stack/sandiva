import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";

export const maxDuration = 60;

const CRITIQUE_SYSTEM = `Anda adalah pengulas dokumen hukum senior di firma hukum litigasi Indonesia.
Tugas Anda: mengkritisi draf dokumen litigasi yang baru dibuat.

INSTRUKSI:
- Identifikasi 2-4 kelemahan SPESIFIK dari draf
- Setiap kelemahan harus menyebutkan: (1) bagian dokumen yang bermasalah, (2) alasan kelemahan, (3) saran perbaikan singkat
- Fokus pada: (1) Kelengkapan dalil hukum, (2) Konsistensi dengan fakta, (3) Kekuatan petitum, (4) Referensi yurisprudensi yang terlewat, (5) Kejelasan bahasa hukum
- Tulis dalam Bahasa Indonesia formal
- PENTING: Kembalikan HANYA JSON array of strings yang valid — tanpa markdown, tanpa pagar kode, tanpa teks lain
- Format contoh: ["1. Dalil PMH pada bagian II.3 terlalu umum — tidak menyebut pasal 1365 KUHPerdata secara eksplisit. Saran: tambahkan kutipan pasal dan referensi yurisprudensi MA.", "2. Petitum angka 3 tidak menyebutkan dasar perhitungan ganti rugi. Saran: perinci komponen kerugian dan metode penghitungannya."]`;

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

    console.log(`[model] stage=kritik-draf model=${MODELS.critique}`);
    const response = await client.messages.create({
      model: MODELS.critique,
      max_tokens: 8192,
      system: CRITIQUE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Kritisi draf ${(docTypeId || "").replace(/_/g, " ")} berikut ini:\n\n${draftText.slice(0, 60000)}`,
        },
      ],
    });

    const raw = response.content.find((b) => b.type === "text")?.text || "";
    console.log(
      `[critique] stop_reason=${response.stop_reason} rawLen=${raw.length} ` +
      `head=${JSON.stringify(raw.slice(0, 150))} tail=${JSON.stringify(raw.slice(-100))}`
    );

    const critiqueItems = parseCritiqueItems(raw);
    console.log(`[critique] items=${critiqueItems.length}`);
    return NextResponse.json({ critiqueItems });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseCritiqueItems(raw: string): string[] {
  // 1. Strip fences
  const stripped = raw.replace(/```json|```/g, "").trim();

  // 2. Try JSON array parse
  const arrayMatch = stripped.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length > 0) {
        return parsed as string[];
      }
    } catch { /* fall through */ }
  }

  // 3. Split by numbered lines (1. / 2. etc.)
  const byNumber = stripped.split(/(?=^\d+\.)/m).map((s) => s.trim()).filter(Boolean);
  if (byNumber.length >= 2) return byNumber;

  // 4. Fallback — wrap entire text as a single item
  return stripped ? [stripped] : ["Kritik tidak tersedia."];
}
