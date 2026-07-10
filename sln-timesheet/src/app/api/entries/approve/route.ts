import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { canTransition } from "@/lib/entries/transitions";

const bodySchema = z.object({
  decisions: z
    .array(
      z.object({
        id: z.number().int().positive(),
        billedUnits: z.number().nonnegative().max(24).nullable().optional(),
        noCharge: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(200),
});

// Approve submitted entries (with optional write-down). The state machine
// guarantees only the matter's ENGAGEMENT PARTNER can do this — not other
// partners, not admin.
export async function POST(req: NextRequest) {
  const auth = requireSession(["partner"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid approval payload.");

  const ids = parsed.data.decisions.map((d) => d.id);
  const entries = await db().select().from(tables.timeEntries).where(inArray(tables.timeEntries.id, ids));
  const matterIds = [...new Set(entries.map((e: any) => e.matterId))] as number[];
  const matters = matterIds.length
    ? await db().select().from(tables.matters).where(inArray(tables.matters.id, matterIds))
    : [];
  const matterById = new Map(matters.map((m: any) => [m.id, m]));
  const byId = new Map(entries.map((e: any) => [e.id, e]));

  let approved = 0;
  let writeDowns = 0;
  const rejected: { id: number; reason: string }[] = [];

  for (const d of parsed.data.decisions) {
    const entry = byId.get(d.id) as any;
    if (!entry) { rejected.push({ id: d.id, reason: "Not found" }); continue; }
    const matter = matterById.get(entry.matterId) as any;
    const gate = canTransition("submitted", "approved", {
      actor: { id: auth.session.userId, role: auth.session.role },
      entry: { userId: entry.userId, status: entry.status },
      matter: { engagementPartnerId: matter.engagementPartnerId, status: matter.status },
    });
    if (!gate.ok) { rejected.push({ id: d.id, reason: gate.reason }); continue; }

    const noCharge = d.noCharge ?? false;
    const billedUnits =
      !noCharge && d.billedUnits !== null && d.billedUnits !== undefined && d.billedUnits !== Number(entry.units)
        ? Math.round(d.billedUnits * 100) / 100
        : null;

    await db()
      .update(tables.timeEntries)
      .set({
        status: "approved",
        noCharge,
        billedUnits: billedUnits !== null ? billedUnits.toFixed(2) : null,
        updatedBy: auth.session.userId,
        updatedAt: new Date(),
      })
      .where(eq(tables.timeEntries.id, entry.id));

    if (noCharge || billedUnits !== null) {
      writeDowns++;
      await db().insert(tables.auditLog).values({
        actorId: auth.session.userId,
        action: "entry_write_down",
        entity: "time_entry",
        entityId: String(entry.id),
        before: { units: entry.units },
        after: { billedUnits, noCharge },
      });
    }
    approved++;
  }

  return NextResponse.json({ ok: true, approved, writeDowns, rejected });
}
