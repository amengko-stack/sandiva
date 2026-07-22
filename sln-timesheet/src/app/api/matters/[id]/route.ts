import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const patchSchema = z.object({
  engagementPartnerId: z.number().int().positive().optional(),
  status: z.enum(["active", "closed"]).optional(),
  feeType: z.enum(["hourly", "lump_sum", "retainer", "success_fee", "internal"]).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(params.id);
  if (!Number.isInteger(id)) return jsonError("Invalid matter id.");
  const matter = await db().query.matters.findFirst({ where: eq(tables.matters.id, id) });
  if (!matter) return jsonError("Matter not found.", 404);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.engagementPartnerId && !parsed.data.status && !parsed.data.feeType)) {
    return jsonError("Nothing to update.");
  }

  if (parsed.data.engagementPartnerId) {
    const partner = await db().query.users.findFirst({ where: eq(tables.users.id, parsed.data.engagementPartnerId) });
    // Admins can also serve as engagement partner — members/accounting cannot.
    if (!partner || (partner.role !== "partner" && partner.role !== "admin"))
      return jsonError("Engagement partner must be a partner or admin.");
  }

  const [updated] = await db()
    .update(tables.matters)
    .set({
      ...(parsed.data.engagementPartnerId ? { engagementPartnerId: parsed.data.engagementPartnerId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.feeType ? { feeType: parsed.data.feeType } : {}),
    })
    .where(eq(tables.matters.id, id))
    .returning();

  const action = parsed.data.status
    ? `matter_${parsed.data.status}`
    : parsed.data.feeType
      ? "matter_fee_type"
      : "matter_reassign_partner";
  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action,
    entity: "matter",
    entityId: String(id),
    before: { engagementPartnerId: matter.engagementPartnerId, status: matter.status, feeType: matter.feeType },
    after: { engagementPartnerId: updated.engagementPartnerId, status: updated.status, feeType: updated.feeType },
  });

  return NextResponse.json({ ok: true, matter: updated });
}
