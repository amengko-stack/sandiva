import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const bodySchema = z.object({
  clientId: z.number().int().positive(),
  matterCode: z.string().trim().min(3).max(30),
  title: z.string().trim().min(2).max(300),
  practiceArea: z.string().trim().max(120).optional(),
  feeType: z.enum(["hourly", "lump_sum", "retainer", "success_fee", "internal"]),
  feeAmount: z.number().nonnegative().optional(),
  currency: z.enum(["IDR", "USD"]),
  engagementPartnerId: z.number().int().positive(),
  up: z.string().trim().max(120).optional(),
});

export async function POST(req: NextRequest) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid matter.");

  const dup = await db().query.matters.findFirst({ where: eq(tables.matters.matterCode, parsed.data.matterCode) });
  if (dup) return jsonError(`Matter ${parsed.data.matterCode} already exists.`);

  const partner = await db().query.users.findFirst({ where: eq(tables.users.id, parsed.data.engagementPartnerId) });
  // Admins can also serve as engagement partner (common at a small firm where
  // the owner is both) — members and accounting still can never be one.
  if (!partner || (partner.role !== "partner" && partner.role !== "admin"))
    return jsonError("Engagement partner must be a partner or admin.");

  const [matter] = await db()
    .insert(tables.matters)
    .values({
      clientId: parsed.data.clientId,
      matterCode: parsed.data.matterCode,
      title: parsed.data.title,
      practiceArea: parsed.data.practiceArea,
      feeType: parsed.data.feeType,
      feeAmount: parsed.data.feeAmount !== undefined ? String(Math.round(parsed.data.feeAmount)) : null,
      currency: parsed.data.currency,
      engagementPartnerId: parsed.data.engagementPartnerId,
      up: parsed.data.up,
      status: "active",
    })
    .returning();

  return NextResponse.json({ ok: true, matter });
}
