import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { canCreateEntry } from "@/lib/entries/transitions";
import { WORKCODES } from "@/lib/constants";

const bodySchema = z.object({
  matterId: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  units: z.number().positive().max(24),
  workcode: z.enum(WORKCODES),
  description: z.string().trim().min(3, "Add a description — it appears on the client invoice.").max(2000),
  // Set true to save despite the duplicate warning.
  force: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const auth = requireSession();
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid entry.");

  const matter = await db().query.matters.findFirst({ where: eq(tables.matters.id, parsed.data.matterId) });
  if (!matter) return jsonError("Matter not found.", 404);

  const gate = canCreateEntry({
    actor: { id: auth.session.userId },
    matter: { status: matter.status },
    forUserId: auth.session.userId,
  });
  if (!gate.ok) return jsonError(gate.reason);

  // Duplicate guard: same person + matter + date + units usually means a
  // double entry. The client re-sends with force:true to save anyway.
  if (!parsed.data.force) {
    const dup = await db().query.timeEntries.findFirst({
      where: and(
        eq(tables.timeEntries.userId, auth.session.userId),
        eq(tables.timeEntries.matterId, matter.id),
        eq(tables.timeEntries.date, parsed.data.date),
        eq(tables.timeEntries.units, (Math.round(parsed.data.units * 100) / 100).toFixed(2)),
      ),
    });
    if (dup) {
      return NextResponse.json(
        { duplicate: true, existingDescription: dup.description },
        { status: 409 },
      );
    }
  }

  const [entry] = await db()
    .insert(tables.timeEntries)
    .values({
      userId: auth.session.userId,
      matterId: matter.id,
      date: parsed.data.date,
      units: (Math.round(parsed.data.units * 100) / 100).toFixed(2),
      workcode: parsed.data.workcode,
      description: parsed.data.description,
      status: "draft",
      updatedBy: auth.session.userId,
    })
    .returning();

  return NextResponse.json({ ok: true, entry });
}
