import { redirect } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth/current-user";
import { ClientsScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");

  const clients = await db().select().from(tables.clients).orderBy(asc(tables.clients.name));
  const matters = await db()
    .select({
      id: tables.matters.id,
      clientId: tables.matters.clientId,
      code: tables.matters.matterCode,
      title: tables.matters.title,
      feeType: tables.matters.feeType,
      currency: tables.matters.currency,
      status: tables.matters.status,
      partnerInitials: tables.users.initials,
      partnerName: tables.users.name,
    })
    .from(tables.matters)
    .innerJoin(tables.users, eq(tables.matters.engagementPartnerId, tables.users.id))
    .orderBy(asc(tables.matters.matterCode));
  const partners = await db()
    .select({ id: tables.users.id, initials: tables.users.initials, name: tables.users.name })
    .from(tables.users)
    .where(inArray(tables.users.role, ["partner", "admin"]));

  return <ClientsScreen clients={clients as any} matters={matters as any} partners={partners as any} />;
}
