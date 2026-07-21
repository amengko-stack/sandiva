import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const bodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  initials: z.string().trim().min(2).max(6).toUpperCase(),
  email: z.string().email().max(200),
  role: z.enum(["member", "partner", "admin", "accounting"]),
  title: z.string().trim().max(60).optional(),
  weeklyTargetUnits: z.number().nonnegative().max(80).default(40),
  billingRateIdr: z.number().nonnegative().optional(),
  billingRateUsd: z.number().nonnegative().optional(),
  costRateIdr: z.number().nonnegative().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// Creates the account. There is no password to set — the person signs in
// immediately via Microsoft Entra ID as long as their email matches.
export async function POST(req: NextRequest) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid user.");
  const d = parsed.data;

  const email = d.email.toLowerCase();
  if (await db().query.users.findFirst({ where: eq(tables.users.email, email) }))
    return jsonError("That email already has an account.");
  if (await db().query.users.findFirst({ where: eq(tables.users.initials, d.initials) }))
    return jsonError(`Initials ${d.initials} are already in use.`);

  const [user] = await db()
    .insert(tables.users)
    .values({
      name: d.name,
      initials: d.initials,
      email,
      role: d.role,
      title: d.title,
      weeklyTargetUnits: String(d.weeklyTargetUnits),
    })
    .returning();

  if (d.billingRateIdr !== undefined || d.billingRateUsd !== undefined || d.costRateIdr !== undefined) {
    await db().insert(tables.userRates).values({
      userId: user.id,
      billingRateIdr: d.billingRateIdr !== undefined ? String(Math.round(d.billingRateIdr)) : null,
      billingRateUsd: d.billingRateUsd !== undefined ? d.billingRateUsd.toFixed(2) : null,
      costRateIdr: d.costRateIdr !== undefined ? String(Math.round(d.costRateIdr)) : null,
      effectiveFrom: d.effectiveFrom ?? new Date().toISOString().slice(0, 10),
    });
  }

  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: "user_created",
    entity: "user",
    entityId: String(user.id),
    after: { name: user.name, initials: user.initials, email: user.email, role: user.role },
  });

  return NextResponse.json({ ok: true, user });
}
