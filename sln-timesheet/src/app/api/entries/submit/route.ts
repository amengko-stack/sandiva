import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { canTransition } from "@/lib/entries/transitions";

const bodySchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) });

export async function POST(req: NextRequest) {
  const auth = requireSession();
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Select at least one draft entry.");

  const entries = await db()
    .select()
    .from(tables.timeEntries)
    .where(inArray(tables.timeEntries.id, parsed.data.ids));

  const matterIds = [...new Set(entries.map((e: any) => e.matterId))] as number[];
  const matters = matterIds.length
    ? await db().select().from(tables.matters).where(inArray(tables.matters.id, matterIds))
    : [];
  const matterById = new Map(matters.map((m: any) => [m.id, m]));

  const submitted: number[] = [];
  const partnerIds = new Set<number>();
  for (const entry of entries) {
    const matter = matterById.get(entry.matterId) as any;
    if (!matter) continue;
    const gate = canTransition("draft", "submitted", {
      actor: { id: auth.session.userId, role: auth.session.role },
      entry: { userId: entry.userId, status: entry.status },
      matter: { engagementPartnerId: matter.engagementPartnerId, status: matter.status },
    });
    if (gate.ok) {
      submitted.push(entry.id);
      partnerIds.add(matter.engagementPartnerId);
    }
  }
  if (!submitted.length) return jsonError("None of the selected entries can be submitted.");

  await db()
    .update(tables.timeEntries)
    .set({ status: "submitted", updatedBy: auth.session.userId, updatedAt: new Date() })
    .where(inArray(tables.timeEntries.id, submitted));

  const partners = await db()
    .select({ initials: tables.users.initials })
    .from(tables.users)
    .where(inArray(tables.users.id, [...partnerIds]));

  return NextResponse.json({
    ok: true,
    submitted: submitted.length,
    routedTo: partners.map((p: any) => p.initials),
  });
}
