import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
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
