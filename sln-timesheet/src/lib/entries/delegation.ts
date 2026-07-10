import { and, eq } from "drizzle-orm";
import { db, tables } from "@/db";

/** True when `delegateId` is registered to act for `principalId`. */
export async function isDelegateOf(delegateId: number, principalId: number): Promise<boolean> {
  if (delegateId === principalId) return false;
  const row = await db().query.delegates.findFirst({
    where: and(eq(tables.delegates.delegateId, delegateId), eq(tables.delegates.principalId, principalId)),
  });
  return !!row;
}

/** The people `delegateId` may log time for (excluding themselves). */
export async function principalsOf(delegateId: number) {
  const rows = await db()
    .select({
      id: tables.users.id,
      name: tables.users.name,
      initials: tables.users.initials,
    })
    .from(tables.delegates)
    .innerJoin(tables.users, eq(tables.delegates.principalId, tables.users.id))
    .where(eq(tables.delegates.delegateId, delegateId));
  return rows as { id: number; name: string; initials: string }[];
}
