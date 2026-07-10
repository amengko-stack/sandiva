import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const patchSchema = z.object({
  engagementPartnerId: z.number().int().positive().optional(),
  status: z.enum(["active", "closed"]).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(params.id);
  if (!Number.isInteger(id)) return jsonError("Invalid matter id.");
  const matter = await db().query.matters.findFirst({ where: eq(tables.matters.id, id) });
  if (!matter) return jsonError("Matter not found.", 404);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.engagementPartnerId && !parsed.data.status)) {
    return jsonError("Nothing to update.");
  }

  if (parsed.data.engagementPartnerId) {
    const partner = await db().query.users.findFirst({ where: eq(tables.users.id, parsed.data.engagementPartnerId) });
    if (!partner || partner.role !== "partner") return jsonError("Engagement partner must be a partner.");
  }

  const [updated] = await db()
    .update(tables.matters)
    .set({
      ...(parsed.data.engagementPartnerId ? { engagementPartnerId: parsed.data.engagementPartnerId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
    })
    .where(eq(tables.matters.id, id))
    .returning();

  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: parsed.data.status ? `matter_${parsed.data.status}` : "matter_reassign_partner",
    entity: "matter",
    entityId: String(id),
    before: { engagementPartnerId: matter.engagementPartnerId, status: matter.status },
    after: { engagementPartnerId: updated.engagementPartnerId, status: updated.status },
  });

  return NextResponse.json({ ok: true, matter: updated });
}
