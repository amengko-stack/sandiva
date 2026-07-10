import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { todayJakarta } from "@/lib/api";
import { isDelegateOf, principalsOf } from "@/lib/entries/delegation";
import { LogTimeForm, type EditEntry } from "./form";

export const dynamic = "force-dynamic";

export default async function LogTimePage({ searchParams }: { searchParams: { edit?: string } }) {
  const user = (await getCurrentUser())!;
  const principals = await principalsOf(user.id);
  let edit: EditEntry | null = null;

  const editId = Number(searchParams.edit);
  if (Number.isInteger(editId) && editId > 0) {
    const entry = await db().query.timeEntries.findFirst({ where: eq(tables.timeEntries.id, editId) });
    const mayEdit =
      entry && (entry.userId === user.id || (await isDelegateOf(user.id, entry.userId)));
    if (entry && mayEdit && entry.status === "draft") {
      const matter = await db().query.matters.findFirst({ where: eq(tables.matters.id, entry.matterId) });
      const client = matter
        ? await db().query.clients.findFirst({ where: eq(tables.clients.id, matter.clientId) })
        : null;
      edit = {
        id: entry.id,
        matterId: entry.matterId,
        matterLabel: matter ? `${matter.matterCode} · ${client?.name ?? ""}` : "",
        date: entry.date,
        units: Number(entry.units),
        workcode: entry.workcode,
        description: entry.description,
      };
    }
  }

  return <LogTimeForm today={todayJakarta()} edit={edit} principals={principals} />;
}
