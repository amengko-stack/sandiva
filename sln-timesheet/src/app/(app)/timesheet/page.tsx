import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { principalsOf } from "@/lib/entries/delegation";
import { TimesheetList } from "./list";

export const dynamic = "force-dynamic";

export default async function TimesheetPage({ searchParams }: { searchParams: { for?: string } }) {
  const user = (await getCurrentUser())!;
  const principals = await principalsOf(user.id);

  // A delegate may view/manage a principal's timesheet via ?for=<id>.
  const forId = Number(searchParams.for);
  const viewing =
    Number.isInteger(forId) && principals.some((p) => p.id === forId)
      ? principals.find((p) => p.id === forId)!
      : null;
  const subjectId = viewing ? viewing.id : user.id;

  const rows = await db()
    .select({
      id: tables.timeEntries.id,
      date: tables.timeEntries.date,
      units: tables.timeEntries.units,
      workcode: tables.timeEntries.workcode,
      description: tables.timeEntries.description,
      status: tables.timeEntries.status,
      sendbackNote: tables.timeEntries.sendbackNote,
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
    .where(eq(tables.timeEntries.userId, subjectId))
    .orderBy(desc(tables.timeEntries.date), desc(tables.timeEntries.id))
    .limit(300);

  return (
    <TimesheetList
      entries={rows as any}
      principals={principals}
      viewingFor={viewing ? { id: viewing.id, name: viewing.name, initials: viewing.initials } : null}
    />
  );
}
