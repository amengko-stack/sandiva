import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const patchSchema = z.object({
  active: z.boolean().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  initials: z.string().trim().min(2).max(6).toUpperCase().optional(),
  email: z.string().email().max(200).optional(),
  title: z.string().trim().max(60).nullable().optional(),
  role: z.enum(["member", "partner", "admin", "accounting"]).optional(),
  weeklyTargetUnits: z.number().nonnegative().max(80).optional(),
});

/** Matters where this user is the engagement partner and still active. */
async function activeEpMatters(userId: number) {
  return db()
    .select({ code: tables.matters.matterCode })
    .from(tables.matters)
    .where(and(eq(tables.matters.engagementPartnerId, userId), eq(tables.matters.status, "active")));
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(params.id);
  if (!Number.isInteger(id)) return jsonError("Invalid user id.");

  const user = await db().query.users.findFirst({ where: eq(tables.users.id, id) });
  if (!user) return jsonError("User not found.", 404);

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Nothing to update.");
  const d = parsed.data;
  if (Object.keys(d).length === 0) return jsonError("Nothing to update.");

  if (d.active === false && id === auth.session.userId)
    return jsonError("You cannot deactivate your own account.");
  if (d.role !== undefined && d.role !== user.role && id === auth.session.userId)
    return jsonError("You cannot change your own role.");

  // Guard: an engagement partner with ACTIVE matters must be reassigned first —
  // whether being deactivated or moved off the partner role, their matters'
  // time could otherwise never be approved.
  if (d.active === false || (d.role !== undefined && user.role === "partner" && d.role !== "partner")) {
    const matters = await activeEpMatters(id);
    if (matters.length) {
      return jsonError(
        `${user.initials} is engagement partner on ${matters.length} active matter${matters.length === 1 ? "" : "s"} (${matters
          .slice(0, 5)
          .map((m: any) => m.code)
          .join(", ")}${matters.length > 5 ? "…" : ""}). Reassign them in Matters first.`,
      );
    }
  }

  const email = d.email?.toLowerCase();
  if (email && email !== user.email) {
    const dup = await db().query.users.findFirst({
      where: and(eq(tables.users.email, email), ne(tables.users.id, id)),
    });
    if (dup) return jsonError("That email already has an account.");
  }
  if (d.initials && d.initials !== user.initials) {
    const dup = await db().query.users.findFirst({
      where: and(eq(tables.users.initials, d.initials), ne(tables.users.id, id)),
    });
    if (dup) return jsonError(`Initials ${d.initials} are already in use.`);
  }

  const updates: Record<string, unknown> = {};
  if (d.active !== undefined) updates.active = d.active;
  if (d.name !== undefined) updates.name = d.name;
  if (d.initials !== undefined) updates.initials = d.initials;
  if (email !== undefined) updates.email = email;
  if (d.title !== undefined) updates.title = d.title || null;
  if (d.role !== undefined) updates.role = d.role;
  if (d.weeklyTargetUnits !== undefined) updates.weeklyTargetUnits = String(d.weeklyTargetUnits);

  await db().update(tables.users).set(updates).where(eq(tables.users.id, id));
  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action:
      d.active !== undefined && Object.keys(d).length === 1
        ? d.active
          ? "user_reactivated"
          : "user_deactivated"
        : "user_updated",
    entity: "user",
    entityId: String(id),
    before: {
      active: user.active, name: user.name, initials: user.initials,
      email: user.email, title: user.title, role: user.role, weeklyTargetUnits: user.weeklyTargetUnits,
    },
    after: updates,
  });

  return NextResponse.json({ ok: true });
}

// Cancels a PENDING invite (no password set yet, so nothing depends on the
// account). Activated users are deactivated instead — history must be kept.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(params.id);
  if (!Number.isInteger(id)) return jsonError("Invalid user id.");

  const user = await db().query.users.findFirst({ where: eq(tables.users.id, id) });
  if (!user) return jsonError("User not found.", 404);
  if (user.passwordHash !== null)
    return jsonError("This account is already activated — deactivate it instead of deleting.", 409);

  const epMatters = await db()
    .select({ id: tables.matters.id })
    .from(tables.matters)
    .where(eq(tables.matters.engagementPartnerId, id));
  if (epMatters.length)
    return jsonError(
      `${user.initials} is engagement partner on ${epMatters.length} matter(s). Reassign them in Matters first.`,
      409,
    );
  const entries = await db()
    .select({ id: tables.timeEntries.id })
    .from(tables.timeEntries)
    .where(eq(tables.timeEntries.userId, id));
  if (entries.length)
    return jsonError(
      `${user.initials} has ${entries.length} time entr${entries.length === 1 ? "y" : "ies"} — deactivate the account instead.`,
      409,
    );

  await db().delete(tables.passwordResets).where(eq(tables.passwordResets.userId, id));
  await db().delete(tables.userRates).where(eq(tables.userRates.userId, id));
  await db().delete(tables.matterRates).where(eq(tables.matterRates.userId, id));
  await db().delete(tables.matterTeam).where(eq(tables.matterTeam.userId, id));
  await db().delete(tables.delegates).where(eq(tables.delegates.delegateId, id));
  await db().delete(tables.delegates).where(eq(tables.delegates.principalId, id));
  await db().delete(tables.users).where(eq(tables.users.id, id));

  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: "invite_cancelled",
    entity: "user",
    entityId: String(id),
    before: { name: user.name, initials: user.initials, email: user.email, role: user.role },
  });

  return NextResponse.json({ ok: true });
}
