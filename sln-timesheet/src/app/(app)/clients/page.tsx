import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { ClientsScreen } from "./screen";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const user = (await getCurrentUser())!;
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
    })
    .from(tables.matters)
    .innerJoin(tables.users, eq(tables.matters.engagementPartnerId, tables.users.id))
    .orderBy(asc(tables.matters.matterCode));
  const partners = await db()
    .select({ id: tables.users.id, initials: tables.users.initials, name: tables.users.name })
    .from(tables.users)
    .where(eq(tables.users.role, "partner"));

  return <ClientsScreen clients={clients as any} matters={matters as any} partners={partners as any} />;
}
