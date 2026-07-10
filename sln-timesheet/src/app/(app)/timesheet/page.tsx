import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { TimesheetList } from "./list";

export const dynamic = "force-dynamic";

export default async function TimesheetPage() {
  const user = (await getCurrentUser())!;

  const rows = await db()
    .select({
      id: tables.timeEntries.id,
      date: tables.timeEntries.date,
      units: tables.timeEntries.units,
      workcode: tables.timeEntries.workcode,
      description: tables.timeEntries.description,
      status: tables.timeEntries.status,
      matterCode: tables.matters.matterCode,
      matterTitle: tables.matters.title,
      clientName: tables.clients.name,
      currency: tables.matters.currency,
      partnerInitials: tables.users.initials,
    })
    .from(tables.timeEntries)
    .innerJoin(tables.matters, eq(tables.timeEntries.matterId, tables.matters.id))
    .innerJoin(tables.clients, eq(tables.matters.clientId, tables.clients.id))
    .innerJoin(tables.users, eq(tables.matters.engagementPartnerId, tables.users.id))
    .where(eq(tables.timeEntries.userId, user.id))
    .orderBy(desc(tables.timeEntries.date), desc(tables.timeEntries.id))
    .limit(300);

  return <TimesheetList entries={rows as any} />;
}
