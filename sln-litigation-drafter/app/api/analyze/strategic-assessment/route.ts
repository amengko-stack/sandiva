import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { CaseAnalysis, InterviewAnswer, StructuredAssessment } from "@/types";
import { MODELS } from "@/config/models";
import { readBlobText } from "@/lib/blob";

export const maxDuration = 300;

const client = new Anthropic();

const SYSTEM = `Anda adalah ahli strategi litigasi senior di firma hukum Indonesia.
Tugas Anda menilai posisi perkara secara jujur dan tajam SEBELUM draf disusun — termasuk risiko yang tidak disadari drafter.
Kembalikan HANYA JSON yang valid, tanpa markdown, tanpa teks lain.`;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, docTypeId, claimType, pihak, kronologi, interviewAnswers, caseAnalysis } =
      (await req.json()) as {
        sessionId?: string;
        docTypeId?: string;
        claimType?: string | null;
        pihak?: string;
        kronologi?: string;
        interviewAnswers: InterviewAnswer[];
        caseAnalysis: CaseAnalysis;
      };
    if (!caseAnalysis) {
      return NextResponse.json({ error: "caseAnalysis wajib diisi" }, { status: 400 });
    }

    const pihakLabel = pihak === "tergugat" ? "Tergugat / Termohon" : "Penggugat / Pemohon";

    // Read the full extracted documents so the model can scan every contract
    // for arbitration clauses and other procedural traps. Read-only use of the
    // existing blob helper.
    let documents = "";
    if (sessionId) {
      documents = (await readBlobText(`sessions/${sessionId}/extracted_text.json`)) ?? "";
      if (documents.length > 120_000) documents = documents.slice(0, 120_000);
    }
    console.log(`[assessment] sessionId=${sessionId} docChars=${documents.length} pihak=${pihak}`);

    const answersText = (interviewAnswers ?? [])
      .map((ia, i) => `${i + 1}. ${ia.question}\n   Jawaban: ${ia.answer || "(tidak dijawab)"}`)
      .join("\n\n");

    const prompt = `Drafter mewakili pihak ${pihakLabel} dalam perkara ${(docTypeId || "").replace(/_/g, " ")}${claimType ? ` (${claimType.replace(/_/g, " ")})` : ""}.

DOKUMEN PERKARA YANG TELAH DIEKSTRAK:
${documents || "(tidak tersedia)"}

KRONOLOGI YANG DIKONFIRMASI:
${(kronologi || caseAnalysis.kronologi || "").slice(0, 6000)}

ANALISIS ELEMEN:
${caseAnalysis.analisisElemen}

POSISI HUKUM:
${caseAnalysis.posisiHukum}

HASIL WAWANCARA KLIEN:
${answersText || "(tidak ada jawaban)"}

---

Buat penilaian strategis dan kembalikan HANYA JSON dengan struktur persis ini:
{
  "kekuatan": ["..."],
  "kelemahan": ["..."],
  "risikoTersembunyi": ["..."],
  "rekomendasi": "..."
}

Ketentuan per bagian:
- kekuatan: hal yang terdukung kuat oleh dokumen — SETIAP butir menyebut dokumen spesifik yang mendukungnya.
- kelemahan: elemen yang lemah atau buktinya kurang — SETIAP butir menjelaskan persis bukti apa yang hilang/kurang.
- risikoTersembunyi: risiko yurisdiksi dan prosedural. WAJIB: periksa SETIAP kontrak/perjanjian dalam dokumen di atas untuk KLAUSULA ARBITRASE — jika ditemukan, butir risiko klausula arbitrase HARUS selalu dimasukkan (sebut nama kontraknya). Periksa juga: daluwarsa/lewat waktu, forum yang keliru, tergugat yang salah atau kurang, kemungkinan gugatan balik (rekonvensi). Jika setelah pemeriksaan sungguh tidak ada risiko, kembalikan array kosong [].
- rekomendasi: satu rekomendasi spesifik dan dapat ditindaklanjuti — lanjutkan / ubah jenis gugatan / ubah forum / kumpulkan bukti dulu. Jika BUKAN "lanjutkan", sebutkan kelemahan spesifik yang mendasarinya.`;

    const message = await client.messages.create({
      model: MODELS.assessment,
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = message.content[0].type === "text" ? message.content[0].text : "";
    console.log(
      `[assessment] stop_reason=${message.stop_reason} rawLen=${raw.length} ` +
      `head=${JSON.stringify(raw.slice(0, 150))} tail=${JSON.stringify(raw.slice(-150))}`
    );

    let assessment: StructuredAssessment | null = null;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        let jsonStr = match[0];
        if (message.stop_reason === "max_tokens") {
          // Truncation repair: close an unfinished string and balance braces
          const quoteCount = (jsonStr.match(/(?<!\\)"/g) || []).length;
          if (quoteCount % 2 !== 0) jsonStr += '"';
          const opens = jsonStr.split("").reduce((d, c) =>
            c === "{" || c === "[" ? d + 1 : c === "}" || c === "]" ? d - 1 : d, 0);
          jsonStr += "]".repeat(0) + "}".repeat(Math.max(0, opens));
          console.log(`[assessment] truncation repair applied`);
        }
        const parsed = JSON.parse(jsonStr) as Partial<StructuredAssessment>;
        assessment = {
          kekuatan: Array.isArray(parsed.kekuatan) ? parsed.kekuatan : [],
          kelemahan: Array.isArray(parsed.kelemahan) ? parsed.kelemahan : [],
          risikoTersembunyi: Array.isArray(parsed.risikoTersembunyi) ? parsed.risikoTersembunyi : [],
          rekomendasi: typeof parsed.rekomendasi === "string" ? parsed.rekomendasi : "",
        };
      }
    } catch (pe) {
      console.error("[assessment] JSON parse failed:", pe instanceof Error ? pe.message : pe);
    }

    if (!assessment || (!assessment.rekomendasi && assessment.kekuatan.length === 0)) {
      throw new Error(
        `Format asesmen tidak valid (stop_reason=${message.stop_reason}). Coba lagi.`
      );
    }

    return NextResponse.json({ assessment });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menghasilkan asesmen";
    console.error("[assessment] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
