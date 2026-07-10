import { redirect } from "next/navigation";
import { asc, desc } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { UsersScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const user = (await getCurrentUser())!;
  if (user.role !== "admin") redirect("/");

  const users = await db()
    .select({
      id: tables.users.id,
      name: tables.users.name,
      initials: tables.users.initials,
      email: tables.users.email,
      role: tables.users.role,
      title: tables.users.title,
      weeklyTargetUnits: tables.users.weeklyTargetUnits,
      active: tables.users.active,
    })
    .from(tables.users)
    .orderBy(asc(tables.users.name));

  const rates = await db()
    .select()
    .from(tables.userRates)
    .orderBy(desc(tables.userRates.effectiveFrom));

  // Current rate per user = newest effectiveFrom row.
  const current = new Map<number, (typeof rates)[number]>();
  for (const r of rates as any[]) if (!current.has(r.userId)) current.set(r.userId, r);

  return (
    <UsersScreen
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
      }))}
    />
  );
}
