import { redirect } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth/current-user";
import { ApprovalsScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const user = await requireUser();
  if (user.role !== "partner") redirect("/");

  const myMatters = await db()
    .select({
      id: tables.matters.id,
      code: tables.matters.matterCode,
      title: tables.matters.title,
      currency: tables.matters.currency,
      clientName: tables.clients.name,
    })
    .from(tables.matters)
    .innerJoin(tables.clients, eq(tables.matters.clientId, tables.clients.id))
    .where(eq(tables.matters.engagementPartnerId, user.id));

  const ids = myMatters.map((m: any) => m.id);
  const entries = ids.length
    ? await db()
        .select({
          id: tables.timeEntries.id,
          matterId: tables.timeEntries.matterId,
          date: tables.timeEntries.date,
          units: tables.timeEntries.units,
          workcode: tables.timeEntries.workcode,
          description: tables.timeEntries.description,
          whoName: tables.users.name,
          whoInitials: tables.users.initials,
        })
        .from(tables.timeEntries)
        .innerJoin(tables.users, eq(tables.timeEntries.userId, tables.users.id))
        .where(and(eq(tables.timeEntries.status, "submitted"), inArray(tables.timeEntries.matterId, ids)))
        .orderBy(asc(tables.timeEntries.date))
    : [];

  return <ApprovalsScreen initials={user.initials} matters={myMatters as any} entries={entries as any} />;
}
