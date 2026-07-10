import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { canTransition } from "@/lib/entries/transitions";

const bodySchema = z.object({ id: z.number().int().positive() });

// Send a submitted entry back to draft — engagement partner only.
export async function POST(req: NextRequest) {
  const auth = requireSession(["partner"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request.");

  const entry = await db().query.timeEntries.findFirst({ where: eq(tables.timeEntries.id, parsed.data.id) });
  if (!entry) return jsonError("Entry not found.", 404);
  const matter = await db().query.matters.findFirst({ where: eq(tables.matters.id, entry.matterId) });
  if (!matter) return jsonError("Matter not found.", 404);

  const gate = canTransition("submitted", "draft", {
    actor: { id: auth.session.userId, role: auth.session.role },
    entry: { userId: entry.userId, status: entry.status },
    matter: { engagementPartnerId: matter.engagementPartnerId, status: matter.status },
  });
  if (!gate.ok) return jsonError(gate.reason, 403);

  await db()
    .update(tables.timeEntries)
    .set({ status: "draft", updatedBy: auth.session.userId, updatedAt: new Date() })
    .where(eq(tables.timeEntries.id, entry.id));

  return NextResponse.json({ ok: true });
}
