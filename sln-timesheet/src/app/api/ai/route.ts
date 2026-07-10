import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { jsonError, requireSession, todayJakarta } from "@/lib/api";
import { firmTotals, utilizationThisWeek } from "@/lib/reports/aggregate";

export const maxDuration = 60;

const bodySchema = z.object({ question: z.string().trim().min(3).max(500) });

// Ask-AI: partner/admin only, READ-ONLY. The model sees pre-computed
// aggregates (the same numbers as the Reports page) — it never touches the
// database and cannot take actions.
export async function POST(req: NextRequest) {
  const auth = requireSession(["partner", "admin"]);
  if (!auth.ok) return auth.response;

  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonError("Ask-AI is not configured yet — set ANTHROPIC_API_KEY.", 503);
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Ask a question about the timesheet data.");

  const [totals, utilization] = await Promise.all([firmTotals(), utilizationThisWeek()]);

  const context = {
    today: todayJakarta(),
    firmTotalsIdr: {
      unbilledWip: totals.wipIdr,
      billedToDate: totals.billedIdr,
      realizationPct: totals.realizationPct,
      avgMarginPct: totals.avgMarginPct,
    },
    matters: totals.perf.map((m) => ({
      project: m.code,
      client: m.clientName,
      matter: m.title,
      feeType: m.feeType,
      currency: m.currency,
      actualUnits: m.actualUnits,
      valueDelivered: m.valueDelivered,
      unbilledWip: m.wip,
      billed: m.billed,
      agreedFee: m.feeAmount,
      marginPct: m.marginPct,
    })),
    utilizationThisWeek: utilization,
  };

  const anthropic = new Anthropic();
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 700,
    system: [
      "You are the analytics assistant inside Sandiva Lawyer Network's timesheet app,",
      "answering partners and admins about the firm's time, billing and utilization data.",
      "Answer concisely in the language of the question (Indonesian or English).",
      "Use ONLY the JSON data provided — never invent numbers. Format IDR like 'Rp 512M'/'Rp 1.04B'",
      "when rounding helps, exact when small. 1 unit = 1 hour. Margin/cost figures are confidential",
      "(your audience is partners/admins, so you may state them). If the data cannot answer the",
      "question, say what's missing. Keep answers under 150 words.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: `Data (aggregates as of ${context.today}):\n${JSON.stringify(context)}\n\nQuestion: ${parsed.data.question}`,
      },
    ],
  });

  const answer = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return NextResponse.json({ ok: true, answer });
}
