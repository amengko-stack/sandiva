import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { priceEntries } from "@/lib/billing/resolve";
import { getSettings } from "@/lib/billing/firm";
import { todayJakarta } from "@/lib/api";
import { AssembleScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage({ searchParams }: { searchParams: { matter?: string } }) {
  const user = (await getCurrentUser())!;
  if (user.role === "member") redirect("/");

  const matterId = Number(searchParams.matter);
  if (!Number.isInteger(matterId)) redirect("/invoices");

  const approvedIds = (
    await db()
      .select({ id: tables.timeEntries.id })
      .from(tables.timeEntries)
      .where(and(eq(tables.timeEntries.matterId, matterId), eq(tables.timeEntries.status, "approved")))
  ).map((r: any) => r.id);
  if (!approvedIds.length) redirect("/invoices");

  const { matter, entries } = await priceEntries(matterId, approvedIds);
  const client = await db().query.clients.findFirst({ where: eq(tables.clients.id, matter.clientId) });
  const partner = await db().query.users.findFirst({ where: eq(tables.users.id, matter.engagementPartnerId) });
  const settings = await getSettings();

  const disbursements = await db()
    .select()
    .from(tables.disbursements)
    .where(and(eq(tables.disbursements.matterId, matterId), isNull(tables.disbursements.invoiceId)));

  return (
    <AssembleScreen
      matter={{
        id: matter.id, code: matter.matterCode, title: matter.title, currency: matter.currency,
        clientName: client?.name ?? "", clientCode: client?.clientCode ?? "",
        up: matter.up ?? client?.contactPerson ?? "", partnerName: partner?.name ?? "", partnerTitle: partner?.title ?? "Partner",
      }}
      entries={entries as any}
      disbursements={(disbursements as any[]).map((d) => ({ id: d.id, date: d.date, description: d.description, amount: Number(d.amount) }))}
      defaultPpn={settings.defaultPpnRate}
      today={todayJakarta()}
    />
  );
}
