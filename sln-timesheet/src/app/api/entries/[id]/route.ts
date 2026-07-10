import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { canEditEntry } from "@/lib/entries/transitions";
import { isDelegateOf } from "@/lib/entries/delegation";
import { WORKCODES } from "@/lib/constants";

const patchSchema = z.object({
  matterId: z.number().int().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  units: z.number().positive().max(24).optional(),
  workcode: z.enum(WORKCODES).optional(),
  description: z.string().trim().min(3).max(2000).optional(),
});

async function loadContext(idParam: string, actorId: number, role: "member" | "partner" | "admin" | "accounting") {
  const id = Number(idParam);
  if (!Number.isInteger(id)) return { error: jsonError("Invalid entry id.") };
  const entry = await db().query.timeEntries.findFirst({ where: eq(tables.timeEntries.id, id) });
  if (!entry) return { error: jsonError("Entry not found.", 404) };
  const matter = await db().query.matters.findFirst({ where: eq(tables.matters.id, entry.matterId) });
  if (!matter) return { error: jsonError("Matter not found.", 404) };
  const gate = canEditEntry({
    actor: { id: actorId, role },
    entry: { userId: entry.userId, status: entry.status },
    matter: { engagementPartnerId: matter.engagementPartnerId, status: matter.status },
    actorIsDelegateOfOwner: actorId !== entry.userId ? await isDelegateOf(actorId, entry.userId) : false,
  });
  if (!gate.ok) return { error: jsonError(gate.reason, 403) };
  return { entry };
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession();
  if (!auth.ok) return auth.response;

  const ctx = await loadContext(params.id, auth.session.userId, auth.session.role);
  if ("error" in ctx) return ctx.error;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid update.");

  if (parsed.data.matterId) {
    const target = await db().query.matters.findFirst({ where: eq(tables.matters.id, parsed.data.matterId) });
    if (!target) return jsonError("Matter not found.", 404);
    if (target.status === "closed") return jsonError("Matter is closed — no new time can be logged.");
  }

  const [entry] = await db()
    .update(tables.timeEntries)
    .set({
      ...(parsed.data.matterId ? { matterId: parsed.data.matterId } : {}),
      ...(parsed.data.date ? { date: parsed.data.date } : {}),
      ...(parsed.data.units !== undefined
        ? { units: (Math.round(parsed.data.units * 100) / 100).toFixed(2) }
        : {}),
      ...(parsed.data.workcode ? { workcode: parsed.data.workcode } : {}),
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      updatedBy: auth.session.userId,
      updatedAt: new Date(),
    })
    .where(eq(tables.timeEntries.id, ctx.entry.id))
    .returning();

  return NextResponse.json({ ok: true, entry });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession();
  if (!auth.ok) return auth.response;

  const ctx = await loadContext(params.id, auth.session.userId, auth.session.role);
  if ("error" in ctx) return ctx.error;

  await db().delete(tables.timeEntries).where(eq(tables.timeEntries.id, ctx.entry.id));
  return NextResponse.json({ ok: true });
}
