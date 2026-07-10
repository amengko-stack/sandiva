import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const patchSchema = z.object({ active: z.boolean() });

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(params.id);
  if (!Number.isInteger(id)) return jsonError("Invalid user id.");
  if (id === auth.session.userId) return jsonError("You cannot deactivate your own account.");

  const user = await db().query.users.findFirst({ where: eq(tables.users.id, id) });
  if (!user) return jsonError("User not found.", 404);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Nothing to update.");

  // Guard: an engagement partner with ACTIVE matters must be reassigned first —
  // otherwise their matters' time could never be approved.
  if (!parsed.data.active) {
    const activeMatters = await db()
      .select({ code: tables.matters.matterCode })
      .from(tables.matters)
      .where(and(eq(tables.matters.engagementPartnerId, id), eq(tables.matters.status, "active")));
    if (activeMatters.length) {
      return jsonError(
        `${user.initials} is engagement partner on ${activeMatters.length} active matter${activeMatters.length === 1 ? "" : "s"} (${activeMatters
          .slice(0, 5)
          .map((m: any) => m.code)
          .join(", ")}${activeMatters.length > 5 ? "…" : ""}). Reassign them in Matters first.`,
      );
    }
  }

  await db().update(tables.users).set({ active: parsed.data.active }).where(eq(tables.users.id, id));
  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: parsed.data.active ? "user_reactivated" : "user_deactivated",
    entity: "user",
    entityId: String(id),
    before: { active: user.active },
    after: { active: parsed.data.active },
  });

  return NextResponse.json({ ok: true });
}
