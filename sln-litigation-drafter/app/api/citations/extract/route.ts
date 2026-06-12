import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { readBlobText } from "@/lib/blob";
import type { CitationItem } from "@/types";

export const maxDuration = 60;

const SYSTEM = `Anda adalah asisten hukum yang mengekstrak dan mengklasifikasikan sitasi dari draf dokumen litigasi Indonesia.
Tugas: identifikasi SETIAP sitasi dalam draf dan klasifikasikan sumbernya berdasarkan dua referensi yang diberikan.
Kembalikan HANYA JSON yang valid, tanpa markdown, tanpa teks lain.`;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, draftText } = (await req.json()) as {
      sessionId: string;
      draftText: string;
    };

    if (!draftText?.trim()) {
      return NextResponse.json({ error: "draftText wajib diisi" }, { status: 400 });
    }

    // Read conventions and case documents in parallel
    const [conventions, caseDocsRaw] = await Promise.all([
      readBlobText("firm_conventions.md"),
      sessionId ? readBlobText(`sessions/${sessionId}/extracted_text.json`) : Promise.resolve(null),
    ]);

    const conventionsText = conventions ?? "(tidak tersedia)";
    const caseDocsText = caseDocsRaw ? caseDocsRaw.slice(0, 100000) : "(tidak tersedia)";

    const prompt = `Ekstrak dan klasifikasikan setiap sitasi dari draf dokumen berikut.

=== REFERENSI 1: KONVENSI FIRMA (termasuk daftar sitasi terverifikasi) ===
${conventionsText.slice(0, 30000)}

=== REFERENSI 2: DOKUMEN PERKARA (ekstrak) ===
${caseDocsText}

=== DRAF YANG DIANALISIS ===
${draftText.slice(0, 60000)}

Identifikasi SETIAP sitasi dalam draf:
- Semua referensi pasal (Pasal X, ps. X) dan UU/PP/Perma/Kepres/dst (UU No. X/Tahun, PP No. X/Tahun, dst)
- Semua nomor putusan Mahkamah Agung (MA No. X/K/..., Putusan MA No. X/...)
- Setiap flag [VERIFIKASI: ...]

Untuk setiap sitasi, tentukan sumbernya:
- "konvensi firma" = nomor/referensi ini muncul secara eksplisit dalam REFERENSI 1
- "dokumen perkara" = nomor/referensi ini muncul secara eksplisit dalam REFERENSI 2
- "perlu verifikasi" = tidak ditemukan di REFERENSI 1 maupun REFERENSI 2 (termasuk semua flag [VERIFIKASI: ...])

Kembalikan HANYA JSON dengan format:
{ "citations": [ { "text": "teks sitasi persis", "type": "pasal_uu" | "yurisprudensi", "source": "konvensi firma" | "dokumen perkara" | "perlu verifikasi", "note": "keterangan singkat opsional" } ] }

- type "pasal_uu" untuk pasal dan UU/PP/dst; type "yurisprudensi" untuk nomor putusan MA dan [VERIFIKASI] flags
- Jika sitasi yang sama muncul beberapa kali, cukup cantumkan satu kali
- Jika tidak ada sitasi sama sekali, kembalikan { "citations": [] }`;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log(`[model] stage=ekstraksi-sitasi model=${MODELS.critique}`);
    const response = await client.messages.create({
      model: MODELS.critique,
      max_tokens: 8192,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content.find((b) => b.type === "text")?.text ?? "";
    console.log(
      `[citations] stop_reason=${response.stop_reason} rawLen=${raw.length} ` +
      `head=${JSON.stringify(raw.slice(0, 150))} tail=${JSON.stringify(raw.slice(-100))}`
    );

    const citations = parseCitations(raw, response.stop_reason ?? "");
    console.log(`[citations] extracted=${citations.length} perluVerifikasi=${citations.filter(c => c.source === "perlu verifikasi").length}`);
    return NextResponse.json({ citations });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    console.error("[citations] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseCitations(raw: string, stopReason: string): CitationItem[] {
  if (stopReason === "max_tokens") {
    console.warn("[citations] response truncated — attempting partial parse");
  }

  // Strip fences
  const stripped = raw.replace(/```json|```/g, "").trim();

  // Find { ... } block
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]) as { citations?: unknown[] };
      if (parsed && Array.isArray(parsed.citations)) {
        const items = parsed.citations.filter(
          (c): c is CitationItem =>
            typeof (c as CitationItem).text === "string" &&
            ["pasal_uu", "yurisprudensi"].includes((c as CitationItem).type) &&
            ["konvensi firma", "dokumen perkara", "perlu verifikasi"].includes((c as CitationItem).source)
        );
        return items;
      }
    } catch {
      console.error("[citations] JSON parse failed raw_head=", raw.slice(0, 200));
    }
  }

  console.error("[citations] could not parse response, returning empty list. raw_head=", raw.slice(0, 300));
  return [];
}
