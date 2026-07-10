import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const bodySchema = z.object({
  defaultPpnRate: z.number().min(0).max(30),
  fxRateUsdIdr: z.number().positive().nullable(),
  roundingRule: z.enum(["2dp", "6min"]),
  firmProfile: z.object({
    name: z.string().trim().min(2),
    addressLines: z.array(z.string()).min(1).max(5),
    npwp: z.string().trim(),
    email: z.string().trim(),
    phone: z.string().trim(),
    bank: z.object({
      accountName: z.string().trim(),
      accountNo: z.string().trim(),
      bankName: z.string().trim(),
      swift: z.string().trim(),
    }),
  }),
});

export async function PUT(req: NextRequest) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid settings.");
  const d = parsed.data;

  await db()
    .insert(tables.settings)
    .values({ id: 1 })
    .onConflictDoNothing();
  await db()
    .update(tables.settings)
    .set({
      defaultPpnRate: d.defaultPpnRate.toFixed(2),
      fxRateUsdIdr: d.fxRateUsdIdr !== null ? d.fxRateUsdIdr.toFixed(2) : null,
      roundingRule: d.roundingRule,
      firmProfile: d.firmProfile,
    })
    .where(eq(tables.settings.id, 1));

  return NextResponse.json({ ok: true });
}
