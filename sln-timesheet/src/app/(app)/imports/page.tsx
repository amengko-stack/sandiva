import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth/current-user";
import { ImportsScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");

  const batches = await db()
    .select()
    .from(tables.importBatches)
    .orderBy(desc(tables.importBatches.createdAt))
    .limit(20);

  const [clients, matters, historicalEntries, nativeEntries, invoices] = await Promise.all([
    db().select({ id: tables.clients.id }).from(tables.clients),
    db().select({ id: tables.matters.id }).from(tables.matters),
    db().select({ id: tables.timeEntries.id }).from(tables.timeEntries).where(eq(tables.timeEntries.isHistorical, true)),
    db().select({ id: tables.timeEntries.id }).from(tables.timeEntries).where(eq(tables.timeEntries.isHistorical, false)),
    db().select({ id: tables.invoices.id }).from(tables.invoices),
  ]);

  const counts = {
    clients: clients.length,
    matters: matters.length,
    historicalEntries: historicalEntries.length,
    nativeEntries: nativeEntries.length,
    invoices: invoices.length,
  };

  return <ImportsScreen batches={batches as any} counts={counts} />;
}
