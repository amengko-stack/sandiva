import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "@/src/prompts";
import { loadDraftMemory, buildMemoryContext } from "@/lib/blob";
import type { CaseAnalysis, InterviewAnswer } from "@/types";
import { MODELS } from "@/config/models";

export const maxDuration = 300;

// A full gugatan from Opus is typically 10–20K tokens; 32K headroom means one
// call usually suffices. If the model still stops at max_tokens, continuation
// calls (up to MAX_DRAFT_CALLS total) stitch the document — assistant prefill
// is rejected on Opus 4.8, so continuation appends the accumulated draft as an
// assistant turn followed by a user "continue" instruction.
const DRAFT_MAX_TOKENS = 32000;
const MAX_DRAFT_CALLS = 3;

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
      interviewAnswers,
      strategicAssessment,
    } = (await req.json()) as {
      docTypeId: string;
      practiceAreaId: string;
      claimType: string | null;
      pihak: string | null;
      ref: string;
      caseAnalysis: CaseAnalysis;
      userCorrections: string;
      interviewAnswers?: InterviewAnswer[];
      strategicAssessment?: string;
    };

    // Budget allocation: 1 full best-match style example (docType+claimType →
    // docType → recency), examples 2-3 at 8K chars, full conventions.
    const memory = await loadDraftMemory(docTypeId, claimType);
    const memoryContext = buildMemoryContext(memory);

    const analysisText = formatCaseAnalysis(
      caseAnalysis,
      userCorrections,
      interviewAnswers ?? [],
      strategicAssessment ?? ""
    );

    const systemPrompt = getSystemPrompt(docTypeId, {
      caseAnalysis: analysisText,
      memoryContext,
      claimType,
      ref,
      pihak,
    });

    // Per-component prompt budget breakdown (chars; tokens ≈ chars/4)
    const interviewChars = (interviewAnswers ?? []).reduce(
      (s, a) => s + a.question.length + a.answer.length, 0
    );
    const comp = (label: string, n: number) => `${label}=${n} (~${Math.round(n / 4)}t)`;
    console.log(
      `[draft] budget: ` +
      comp("conventions", memory.conventions.length) + " " +
      memory.styleExamples.map((e, i) => comp(`style${i + 1}[${e.label}|${e.type}/${e.claimType}|source=${e.source ?? "approved"}]`, e.content.length)).join(" ") + " " +
      comp("kronologi", caseAnalysis.kronologi?.length ?? 0) + " " +
      comp("analysisOther", analysisText.length - (caseAnalysis.kronologi?.length ?? 0)) + " " +
      comp("interview", interviewChars) + " " +
      comp("assessment", strategicAssessment?.length ?? 0) + " " +
      comp("userCorrections", userCorrections?.length ?? 0) + " | " +
      comp("TOTAL systemPrompt", systemPrompt.length) +
      ` | documentText=0 by design (drafts from caseAnalysis)`
    );

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const initialUserMsg = `Susun dokumen litigasi lengkap berdasarkan analisis kasus dan instruksi sistem di atas. Tulis dalam Bahasa Indonesia formal. Nomor referensi: ${ref}`;

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        try {
          let fullText = "";
          let stopReason: string | null = null;

          for (let call = 0; call < MAX_DRAFT_CALLS; call++) {
            // First call: just the instruction. Continuations: accumulated
            // draft as an assistant turn + user instruction to continue
            // (last-assistant-turn prefill 400s on Opus 4.8).
            const messages: Anthropic.MessageParam[] =
              call === 0
                ? [{ role: "user", content: initialUserMsg }]
                : [
                    { role: "user", content: initialUserMsg },
                    { role: "assistant", content: fullText },
                    {
                      role: "user",
                      content:
                        "Draf di atas terpotong sebelum selesai. Lanjutkan PERSIS dari titik terakhir terputus — jangan mengulang bagian yang sudah ditulis, jangan menambahkan pembuka atau komentar, langsung sambung kalimatnya hingga dokumen lengkap.",
                    },
                  ];

            const stream = client.messages.stream({
              model: MODELS.drafting,
              max_tokens: DRAFT_MAX_TOKENS,
              system: systemPrompt,
              messages,
            });

            for await (const event of stream) {
              if (
                event.type === "content_block_delta" &&
                event.delta.type === "text_delta"
              ) {
                const chunk = event.delta.text;
                fullText += chunk;
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ chunk })}\n\n`)
                );
              }
            }

            const finalMessage = await stream.finalMessage();
            stopReason = finalMessage.stop_reason;
            console.log(
              `[draft] call=${call + 1}/${MAX_DRAFT_CALLS} stop_reason=${stopReason} ` +
              `max_tokens=${DRAFT_MAX_TOKENS} input_tokens=${finalMessage.usage.input_tokens} ` +
              `output_tokens=${finalMessage.usage.output_tokens} totalChars=${fullText.length}`
            );

            if (stopReason !== "max_tokens") break;
          }

          if (stopReason === "max_tokens") {
            console.error(`[draft] still truncated after ${MAX_DRAFT_CALLS} calls (${fullText.length} chars)`);
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ done: true, stopReason })}\n\n`)
          );
          controller.close();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Stream error";
          console.error("[draft] stream error:", msg);
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
  corrections: string,
  interviewAnswers: InterviewAnswer[],
  strategicAssessment: string
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

  if (interviewAnswers.length > 0) {
    const qa = interviewAnswers
      .filter((a) => a.answer?.trim())
      .map((a, i) => `${i + 1}. T: ${a.question}\n   J: ${a.answer}`)
      .join("\n");
    if (qa) text += `\n\n## HASIL WAWANCARA KLIEN\n${qa}`;
  }

  if (strategicAssessment.trim()) {
    text += `\n\n## ASESMEN STRATEGIS (telah dikonfirmasi drafter)\n${strategicAssessment}`;
  }

  if (corrections?.trim()) {
    text += `\n\n## KOREKSI DAN CATATAN DRAFTER\n${corrections}`;
  }

  return text;
}
