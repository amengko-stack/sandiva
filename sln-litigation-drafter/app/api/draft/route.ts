import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "@/src/prompts";
import { loadMemoryLibrary, buildMemoryContext } from "@/lib/blob";
import type { CaseAnalysis } from "@/types";
import { MODELS } from "@/config/models";

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

    // Issue 3 diagnostics: confirm firm samples actually reach the prompt
    console.log(
      `[draft] memory: conventions=${memory.conventions ? `${memory.conventions.length} chars` : "NOT LOADED"} ` +
      `styleExamples=${memory.styleExamples.length} ` +
      `labels=[${memory.styleExamples.map((e) => e.label).join(" | ")}] ` +
      `styleChars=${memory.styleExamples.reduce((s, e) => s + e.content.length, 0)} ` +
      `patterns=${memory.patterns.totalDrafts}`
    );

    // Per-component prompt budget breakdown (chars; tokens ≈ chars/4)
    const comp = (label: string, n: number) => `${label}=${n} (~${Math.round(n / 4)}t)`;
    console.log(
      `[draft] budget: ` +
      comp("conventions", memory.conventions.length) + " " +
      memory.styleExamples.map((e, i) => comp(`style${i + 1}[${e.label}]`, e.content.length)).join(" ") + " " +
      comp("identitasPihak", caseAnalysis.identitasPihak?.length ?? 0) + " " +
      comp("hubunganHukum", caseAnalysis.hubunganHukum?.length ?? 0) + " " +
      comp("kronologi", caseAnalysis.kronologi?.length ?? 0) + " " +
      comp("elemenHukum", caseAnalysis.elemenHukum?.length ?? 0) + " " +
      comp("analisisElemen", caseAnalysis.analisisElemen?.length ?? 0) + " " +
      comp("buktiKunci", caseAnalysis.buktiKunci?.length ?? 0) + " " +
      comp("kelemahanGaps", caseAnalysis.kelemahanGaps?.length ?? 0) + " " +
      comp("posisiHukum", caseAnalysis.posisiHukum?.length ?? 0) + " " +
      comp("userCorrections", userCorrections?.length ?? 0) +
      ` | NOTE: documentText=0 (Stage 4 drafts from caseAnalysis, not raw text); interview=0 assessment=0 (NOT sent to /api/draft)`
    );

    const analysisText = formatCaseAnalysis(caseAnalysis, userCorrections);

    const systemPrompt = getSystemPrompt(docTypeId, {
      caseAnalysis: analysisText,
      memoryContext,
      claimType,
      ref,
      pihak,
    });

    // Issue 1 diagnostics: input size estimate (chars/4 ≈ tokens)
    console.log(
      `[draft] input: systemPrompt=${systemPrompt.length} chars (~${Math.round(systemPrompt.length / 4)} tokens est) ` +
      `analysisText=${analysisText.length} memoryContext=${memoryContext.length}`
    );

    const DRAFT_MAX_TOKENS = 8192;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const stream = await client.messages.stream({
      model: MODELS.drafting,
      max_tokens: DRAFT_MAX_TOKENS,
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
          let outputChars = 0;
          for await (const event of stream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              const chunk = event.delta.text;
              outputChars += chunk.length;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`)
              );
            }
          }
          // Issue 1 diagnostics: was the draft cut off by the output limit?
          const finalMessage = await stream.finalMessage();
          console.log(
            `[draft] DONE stop_reason=${finalMessage.stop_reason} max_tokens=${DRAFT_MAX_TOKENS} ` +
            `input_tokens=${finalMessage.usage.input_tokens} output_tokens=${finalMessage.usage.output_tokens} ` +
            `outputChars=${outputChars}`
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ done: true, stopReason: finalMessage.stop_reason })}\n\n`)
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
