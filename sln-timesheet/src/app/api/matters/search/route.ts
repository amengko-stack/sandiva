import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireSession } from "@/lib/api";

// Searchable matter picker: ACTIVE matters only (closed are hidden — no new
// charges), caller's team matters sorted first.
export async function GET(req: NextRequest) {
  const auth = requireSession();
  if (!auth.ok) return auth.response;

  const q = (req.nextUrl.searchParams.get("q") ?? "").toLowerCase().trim();

  const rows = await db()
    .select({
      id: tables.matters.id,
      code: tables.matters.matterCode,
      title: tables.matters.title,
      feeType: tables.matters.feeType,
      currency: tables.matters.currency,
      clientName: tables.clients.name,
      partnerInitials: tables.users.initials,
      partnerName: tables.users.name,
    })
    .from(tables.matters)
    .innerJoin(tables.clients, eq(tables.matters.clientId, tables.clients.id))
    .innerJoin(tables.users, eq(tables.matters.engagementPartnerId, tables.users.id))
    .where(eq(tables.matters.status, "active"));

  const team = await db()
    .select({ matterId: tables.matterTeam.matterId })
    .from(tables.matterTeam)
    .where(eq(tables.matterTeam.userId, auth.session.userId));
  const mine = new Set(team.map((t: { matterId: number }) => t.matterId));

  const filtered = rows
    .filter((m: any) => !q || `${m.code} ${m.clientName} ${m.title}`.toLowerCase().includes(q))
    .map((m: any) => ({ ...m, mine: mine.has(m.id) }))
    .sort((a: any, b: any) => Number(b.mine) - Number(a.mine) || a.code.localeCompare(b.code))
    .slice(0, 30);

  return NextResponse.json({ matters: filtered });
}
