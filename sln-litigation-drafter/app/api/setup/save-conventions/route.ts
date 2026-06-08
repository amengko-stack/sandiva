import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { writeBlobText, readBlobText } from "@/lib/blob";

export const maxDuration = 120;

const SETUP_SYSTEM = `Anda adalah konsultan legal technology yang membantu firma hukum mendokumentasikan konvensi penulisan dokumen litigasi.
Dokumen ini akan digunakan sebagai panduan AI untuk menyusun dokumen-dokumen berikutnya.
Format: Markdown terstruktur dengan header yang jelas.
Tulis dalam Bahasa Indonesia formal.`;

const DOC_LABELS: Record<string, string> = {
  gugatan:            "Gugatan",
  jawaban:            "Jawaban",
  replik:             "Replik",
  duplik:             "Duplik",
  kesimpulan:         "Kesimpulan Perdata",
  permohonan_pkpu:    "Permohonan PKPU",
  permohonan_pailit:  "Permohonan Pailit",
  jawaban_pkpu:       "Jawaban PKPU / Pailit",
  rencana_perdamaian: "Rencana Perdamaian",
  kesimpulan_pkpu:    "Kesimpulan PKPU / Pailit",
};

export async function POST(req: NextRequest) {
  try {
    const { samples, generalRefinements } = await req.json() as {
      samples: Record<string, { analysis: string; refinements: string }>;
      generalRefinements: string;
    };

    const existingConventions = await readBlobText("firm_conventions.md");
    const isRerun = !!existingConventions && existingConventions.length > 50;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const sampleSections = Object.entries(samples)
      .filter(([, v]) => v.analysis || v.refinements)
      .map(([key, v]) => {
        const label = DOC_LABELS[key] ?? key;
        let section = `### ${label}\n`;
        if (v.analysis) section += `**Analisis sampel:**\n${v.analysis}\n`;
        if (v.refinements) section += `**Catatan tambahan:**\n${v.refinements}\n`;
        return section;
      })
      .join("\n");

    const prompt = isRerun
      ? `Berikut adalah konvensi firma yang sudah ada:

<konvensi_saat_ini>
${existingConventions}
</konvensi_saat_ini>

Berikut adalah informasi baru yang perlu digabungkan:

${sampleSections || "[tidak ada sampel baru]"}

${generalRefinements ? `**Catatan umum tambahan:**\n${generalRefinements}` : ""}

---

Perbarui dan gabungkan konvensi di atas dengan informasi baru. Pertahankan semua konvensi yang sudah ada. Tambahkan atau perkuat bagian yang relevan berdasarkan sampel dan catatan baru. Jika ada konflik, gunakan informasi yang lebih spesifik. Hasilkan dokumen firm_conventions.md yang lengkap dan terpadu.`
      : `Buat dokumen firm_conventions.md untuk Sandiva Legal Network berdasarkan informasi berikut:

${sampleSections || "[tidak ada sampel]"}

${generalRefinements ? `**Catatan umum:**\n${generalRefinements}` : ""}

---

Dokumen harus mencakup:
1. Identitas Para Pihak (format yang digunakan)
2. Struktur dokumen per jenis
3. Gaya bahasa dan register hukum
4. Format petitum standar
5. Sitasi yurisprudensi (jika teridentifikasi)
6. Konvensi khusus firma yang teramati
7. Instruksi untuk AI drafter`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: SETUP_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });

    const conventions = response.content.find((b) => b.type === "text")?.text || "";

    await writeBlobText("firm_conventions.md", conventions);

    // Only initialise pattern/style stores on first run
    if (!isRerun) {
      await writeBlobText("case_patterns.json", JSON.stringify({ totalDrafts: 0, patterns: [] }));
      await writeBlobText("style_examples/index.json", JSON.stringify([]));
    }

    return NextResponse.json({ ok: true, conventions, isRerun });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
