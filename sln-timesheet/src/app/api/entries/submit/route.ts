import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { canTransition } from "@/lib/entries/transitions";
import { notifySubmission } from "@/lib/email/notify";

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
    // Resubmitting clears any previous send-back reason.
    .set({ status: "submitted", sendbackNote: null, updatedBy: auth.session.userId, updatedAt: new Date() })
    .where(inArray(tables.timeEntries.id, submitted));

  const partners = await db()
    .select({ id: tables.users.id, initials: tables.users.initials, name: tables.users.name, email: tables.users.email })
    .from(tables.users)
    .where(inArray(tables.users.id, [...partnerIds]));

  // Notify each engagement partner about their share (fire-and-forget).
  const submitter = await db().query.users.findFirst({ where: eq(tables.users.id, auth.session.userId) });
  if (submitter) {
    for (const partner of partners as any[]) {
      const theirMatters = matters.filter(
        (m: any) => m.engagementPartnerId === partner.id && entries.some((e: any) => e.matterId === m.id && submitted.includes(e.id)),
      );
      const theirCount = entries.filter(
        (e: any) => submitted.includes(e.id) && theirMatters.some((m: any) => m.id === e.matterId),
      ).length;
      if (theirCount > 0) {
        notifySubmission({
          partnerEmail: partner.email,
          partnerName: partner.name,
          submitterName: submitter.name,
          count: theirCount,
          matterCodes: theirMatters.map((m: any) => m.matterCode),
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    submitted: submitted.length,
    routedTo: partners.map((p: any) => p.initials),
  });
}
