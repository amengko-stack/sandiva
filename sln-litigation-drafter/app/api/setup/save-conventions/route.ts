import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { writeBlobText } from "@/lib/blob";

export const maxDuration = 120;

const SETUP_SYSTEM = `Anda adalah konsultan legal technology yang membantu firma hukum mendokumentasikan konvensi penulisan dokumen litigasi.
Tugas: Berdasarkan analisis sampel dokumen dan catatan dari lawyer, buat dokumen "firm_conventions.md" yang komprehensif.
Dokumen ini akan digunakan sebagai panduan AI untuk menyusun dokumen-dokumen berikutnya.
Format: Markdown yang terstruktur dengan header yang jelas.
Tulis dalam Bahasa Indonesia formal.`;

export async function POST(req: NextRequest) {
  try {
    const {
      gugatanAnalysis,
      gugatanRefinements,
      jawabanAnalysis,
      jawabanRefinements,
      generalRefinements,
    } = await req.json();

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `
Berdasarkan informasi berikut, buat dokumen firm_conventions.md untuk Sandiva Legal Network:

## ANALISIS SAMPEL GUGATAN:
${gugatanAnalysis || "[tidak tersedia]"}

## CATATAN REFINEMENTS GUGATAN:
${gugatanRefinements || "[tidak ada]"}

## ANALISIS SAMPEL JAWABAN:
${jawabanAnalysis || "[tidak tersedia]"}

## CATATAN REFINEMENTS JAWABAN:
${jawabanRefinements || "[tidak ada]"}

## CATATAN UMUM SEMUA JENIS DOKUMEN:
${generalRefinements || "[tidak ada]"}

---

Buat firm_conventions.md yang mencakup:
1. Identitas Para Pihak (format yang digunakan)
2. Struktur dokumen per jenis (gugatan, jawaban, replik, duplik, kesimpulan)
3. Gaya bahasa dan register hukum
4. Format petitum standar
5. Sitasi yurisprudensi (jika teridentifikasi)
6. Konvensi khusus firma yang teramati
7. Instruksi untuk AI drafter
`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: SETUP_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });

    const conventions = response.content.find((b) => b.type === "text")?.text || "";

    // Save to Vercel Blob
    await writeBlobText("firm_conventions.md", conventions);
    await writeBlobText("case_patterns.json", JSON.stringify({ totalDrafts: 0, patterns: [] }));
    await writeBlobText("style_examples/index.json", JSON.stringify([]));

    return NextResponse.json({ ok: true, conventions });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
