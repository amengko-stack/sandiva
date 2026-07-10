import { redirect } from "next/navigation";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { priceEntries } from "@/lib/billing/resolve";
import { getSettings } from "@/lib/billing/firm";
import { todayJakarta } from "@/lib/api";
import { budgetAlerts } from "@/lib/reports/aggregate";
import { AssembleScreen } from "./screen";

export const dynamic = "force-dynamic";

// /invoices/new?matter=2            — single-matter invoice
// /invoices/new?matters=2,5,7       — combined invoice (same client/currency/partner)
export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: { matter?: string; matters?: string };
}) {
  const user = (await getCurrentUser())!;
  if (user.role === "member") redirect("/");

  const ids = (searchParams.matters ?? searchParams.matter ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) redirect("/invoices");

  const matters = await db().select().from(tables.matters).where(inArray(tables.matters.id, ids));
  if (matters.length !== ids.length) redirect("/invoices");
  const clientIds = new Set(matters.map((m: any) => m.clientId));
  const currencies = new Set(matters.map((m: any) => m.currency));
  const partnerIds = new Set(matters.map((m: any) => m.engagementPartnerId));
  if (clientIds.size > 1 || currencies.size > 1 || partnerIds.size > 1) redirect("/invoices");

  const client = await db().query.clients.findFirst({ where: eq(tables.clients.id, matters[0].clientId) });
  const partner = await db().query.users.findFirst({ where: eq(tables.users.id, matters[0].engagementPartnerId) });
  const settings = await getSettings();

  const entries: any[] = [];
  for (const m of matters as any[]) {
    const approvedIds = (
      await db()
        .select({ id: tables.timeEntries.id })
        .from(tables.timeEntries)
        .where(and(eq(tables.timeEntries.matterId, m.id), eq(tables.timeEntries.status, "approved")))
    ).map((r: any) => r.id);
    if (!approvedIds.length) continue;
    const priced = await priceEntries(m.id, approvedIds);
    for (const e of priced.entries) entries.push({ ...e, matterCode: m.matterCode });
  }
  if (!entries.length) redirect("/invoices");

  const disbursements = await db()
    .select()
    .from(tables.disbursements)
    .where(and(inArray(tables.disbursements.matterId, ids), isNull(tables.disbursements.invoiceId)));

  const alerts = await budgetAlerts();
  const alert = matters.length === 1 ? (alerts.find((a) => a.matterId === matters[0].id) ?? null) : null;
  const codes = matters.map((m: any) => m.matterCode).sort();

  return (
    <AssembleScreen
      matter={{
        ids,
        code: codes.join(", "),
        title:
          matters.length === 1 ? matters[0].title : `Combined invoice — ${matters.length} matters`,
        currency: matters[0].currency,
        clientName: client?.name ?? "",
        clientCode: client?.clientCode ?? "",
        up: (matters.length === 1 ? matters[0].up : null) ?? client?.contactPerson ?? "",
        partnerName: partner?.name ?? "",
        partnerTitle: partner?.title ?? "Partner",
        combined: matters.length > 1,
      }}
      entries={entries as any}
      disbursements={(disbursements as any[]).map((d) => ({
        id: d.id,
        date: d.date,
        description: d.description,
        amount: Number(d.amount),
      }))}
      defaultPpn={settings.defaultPpnRate}
      today={todayJakarta()}
      budget={alert ? { pct: alert.pct, level: alert.level } : null}
    />
  );
}
