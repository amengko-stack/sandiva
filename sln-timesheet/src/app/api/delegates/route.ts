import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const bodySchema = z.object({
  delegateId: z.number().int().positive(),
  principalId: z.number().int().positive(),
});

// Admin-managed mapping: delegate may enter/manage time for principal.
export async function POST(req: NextRequest) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Pick both people.");
  const { delegateId, principalId } = parsed.data;
  if (delegateId === principalId) return jsonError("Someone cannot be their own delegate.");

  const [delegate, principal] = await Promise.all([
    db().query.users.findFirst({ where: eq(tables.users.id, delegateId) }),
    db().query.users.findFirst({ where: eq(tables.users.id, principalId) }),
  ]);
  if (!delegate || !principal) return jsonError("User not found.", 404);

  const existing = await db().query.delegates.findFirst({
    where: and(eq(tables.delegates.delegateId, delegateId), eq(tables.delegates.principalId, principalId)),
  });
  if (existing) return jsonError(`${delegate.initials} already logs for ${principal.initials}.`);

  const [row] = await db().insert(tables.delegates).values({ delegateId, principalId }).returning();
  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: "delegate_added",
    entity: "delegate",
    entityId: String(row.id),
    after: { delegate: delegate.initials, principal: principal.initials },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id)) return jsonError("Invalid mapping id.");
  const row = await db().query.delegates.findFirst({ where: eq(tables.delegates.id, id) });
  if (!row) return jsonError("Mapping not found.", 404);

  await db().delete(tables.delegates).where(eq(tables.delegates.id, id));
  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: "delegate_removed",
    entity: "delegate",
    entityId: String(id),
    before: { delegateId: row.delegateId, principalId: row.principalId },
  });
  return NextResponse.json({ ok: true });
}
