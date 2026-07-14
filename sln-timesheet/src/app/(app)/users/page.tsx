import { redirect } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth/current-user";
import { UsersScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");

  const users = (
    await db()
      .select({
        id: tables.users.id,
        name: tables.users.name,
        initials: tables.users.initials,
        email: tables.users.email,
        role: tables.users.role,
        title: tables.users.title,
        weeklyTargetUnits: tables.users.weeklyTargetUnits,
        active: tables.users.active,
        passwordHash: tables.users.passwordHash,
      })
      .from(tables.users)
      .orderBy(asc(tables.users.name))
  ).map(({ passwordHash, ...u }: any) => ({ ...u, pending: passwordHash === null }));

  const rates = await db()
    .select()
    .from(tables.userRates)
    .orderBy(desc(tables.userRates.effectiveFrom));

  // Current rate per user = newest effectiveFrom row; full history for the viewer.
  const current = new Map<number, (typeof rates)[number]>();
  const historyByUser = new Map<number, any[]>();
  for (const r of rates as any[]) {
    if (!current.has(r.userId)) current.set(r.userId, r);
    (historyByUser.get(r.userId) ?? historyByUser.set(r.userId, []).get(r.userId)!).push({
      billingRateIdr: r.billingRateIdr,
      billingRateUsd: r.billingRateUsd,
      costRateIdr: r.costRateIdr,
      effectiveFrom: r.effectiveFrom,
    });
  }

  const principalUsers = alias(tables.users, "principal_users");
  const mappings = await db()
    .select({
      id: tables.delegates.id,
      delegateInitials: tables.users.initials,
      delegateName: tables.users.name,
      principalInitials: principalUsers.initials,
      principalName: principalUsers.name,
    })
    .from(tables.delegates)
    .innerJoin(tables.users, eq(tables.delegates.delegateId, tables.users.id))
    .innerJoin(principalUsers, eq(tables.delegates.principalId, principalUsers.id));

  return (
    <UsersScreen
      delegates={mappings as any}
      users={users.map((u: any) => ({
        ...u,
        rate: current.get(u.id)
          ? {
              billingRateIdr: current.get(u.id)!.billingRateIdr,
              billingRateUsd: current.get(u.id)!.billingRateUsd,
              costRateIdr: current.get(u.id)!.costRateIdr,
              effectiveFrom: current.get(u.id)!.effectiveFrom,
            }
          : null,
        rateHistory: historyByUser.get(u.id) ?? [],
      }))}
    />
  );
}
