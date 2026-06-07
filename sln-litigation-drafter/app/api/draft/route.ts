import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "@/src/prompts";
import { loadMemoryLibrary, buildMemoryContext } from "@/lib/blob";
import type { CaseAnalysis } from "@/types";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const {
      docTypeId,
      practiceAreaId,
      claimType,
      pihak,
      ref,
      caseAnalysis,
      userCorrections,
    } = (await req.json()) as {
      docTypeId: string;
      practiceAreaId: string;
      claimType: string | null;
      pihak: string | null;
      ref: string;
      caseAnalysis: CaseAnalysis;
      userCorrections: string;
    };

    const memory = await loadMemoryLibrary();
    const memoryContext = buildMemoryContext(memory);

    const analysisText = formatCaseAnalysis(caseAnalysis, userCorrections);

    const systemPrompt = getSystemPrompt(docTypeId, {
      caseAnalysis: analysisText,
      memoryContext,
      claimType,
      ref,
      pihak,
    });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const stream = await client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Susun dokumen litigasi lengkap berdasarkan analisis kasus dan instruksi sistem di atas. Tulis dalam Bahasa Indonesia formal. Nomor referensi: ${ref}`,
        },
      ],
    });

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const chunk = event.delta.text;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`)
              );
            }
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`)
          );
          controller.close();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Stream error";
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`)
          );
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

function formatCaseAnalysis(
  analysis: CaseAnalysis,
  corrections: string
): string {
  const sections = [
    ["Identitas Para Pihak", analysis.identitasPihak],
    ["Hubungan Hukum Para Pihak", analysis.hubunganHukum],
    ["Kronologi Fakta Material", analysis.kronologi],
    ["Elemen Hukum yang Dianalisis", analysis.elemenHukum],
    ["Analisis Elemen per Elemen", analysis.analisisElemen],
    ["Dokumen/Bukti Kunci", analysis.buktiKunci],
    ["Kelemahan dan Gaps", analysis.kelemahanGaps],
    ["Posisi Hukum yang Direkomendasikan", analysis.posisiHukum],
  ];

  let text = sections
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `## ${k}\n${v}`)
    .join("\n\n");

  if (corrections?.trim()) {
    text += `\n\n## KOREKSI DAN CATATAN DRAFTER\n${corrections}`;
  }

  return text;
}
