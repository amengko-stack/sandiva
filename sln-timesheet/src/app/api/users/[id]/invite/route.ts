import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { issueInviteLink } from "@/lib/auth/invite";

// Re-issues a set-password link. For a pending user this resends the invite;
// for an activated user it acts as an admin-issued password-reset link (the
// escape hatch when the user lost their password and email delivery is broken).
// Either way the previous unused token is invalidated.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(params.id);
  if (!Number.isInteger(id)) return jsonError("Invalid user id.");

  const user = await db().query.users.findFirst({ where: eq(tables.users.id, id) });
  if (!user) return jsonError("User not found.", 404);
  if (!user.active) return jsonError("Reactivate the account first — links for inactive users won't work.");

  const { inviteUrl, emailSent } = await issueInviteLink(user);

  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: user.passwordHash === null ? "invite_resent" : "reset_link_issued",
    entity: "user",
    entityId: String(id),
    after: { email: user.email, emailSent },
  });

  return NextResponse.json({ ok: true, inviteUrl, emailSent, pending: user.passwordHash === null });
}
