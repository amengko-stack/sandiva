import { redirect } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth/current-user";
import { budgetAlerts } from "@/lib/reports/aggregate";
import { MattersScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function MattersPage() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");

  const matters = await db()
    .select({
      id: tables.matters.id,
      code: tables.matters.matterCode,
      title: tables.matters.title,
      feeType: tables.matters.feeType,
      currency: tables.matters.currency,
      status: tables.matters.status,
      engagementPartnerId: tables.matters.engagementPartnerId,
      clientName: tables.clients.name,
    })
    .from(tables.matters)
    .innerJoin(tables.clients, eq(tables.matters.clientId, tables.clients.id))
    .orderBy(asc(tables.matters.matterCode));

  const partners = await db()
    .select({ id: tables.users.id, initials: tables.users.initials, name: tables.users.name })
    .from(tables.users)
    .where(inArray(tables.users.role, ["partner", "admin"]));

  const alerts = await budgetAlerts();
  const budgetByMatter = Object.fromEntries(alerts.map((a) => [a.matterId, { pct: a.pct, level: a.level }]));

  return <MattersScreen matters={matters as any} partners={partners as any} budgets={budgetByMatter} />;
}
