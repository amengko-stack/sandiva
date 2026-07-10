import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const bodySchema = z.object({
  billingRateIdr: z.number().nonnegative().nullable(),
  billingRateUsd: z.number().nonnegative().nullable(),
  costRateIdr: z.number().nonnegative().nullable(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// New rate row with an effective date — history is preserved; past entries
// keep billing at the rate in force on their date.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const userId = Number(params.id);
  if (!Number.isInteger(userId)) return jsonError("Invalid user id.");
  const user = await db().query.users.findFirst({ where: eq(tables.users.id, userId) });
  if (!user) return jsonError("User not found.", 404);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid rate.");
  const d = parsed.data;

  const [rate] = await db()
    .insert(tables.userRates)
    .values({
      userId,
      billingRateIdr: d.billingRateIdr !== null ? String(Math.round(d.billingRateIdr)) : null,
      billingRateUsd: d.billingRateUsd !== null ? d.billingRateUsd.toFixed(2) : null,
      costRateIdr: d.costRateIdr !== null ? String(Math.round(d.costRateIdr)) : null,
      effectiveFrom: d.effectiveFrom,
    })
    .returning();

  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: "rate_added",
    entity: "user_rates",
    entityId: String(rate.id),
    after: rate,
  });

  return NextResponse.json({ ok: true, rate });
}
