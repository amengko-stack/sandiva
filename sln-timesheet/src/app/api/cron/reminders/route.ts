import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lte } from "drizzle-orm";
import { db, tables } from "@/db";
import { sendEmail } from "@/lib/email";
import { weekOf } from "@/lib/entries/week";
import { todayJakarta } from "@/lib/api";

export const maxDuration = 60;

// Weekly nudge (Vercel Cron, see vercel.json): emails members whose logged
// units this week are under half their target, or who have stale drafts.
// Secured by CRON_SECRET bearer — Vercel's invoker carries no session cookie.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const week = weekOf(todayJakarta());
  const users = await db().select().from(tables.users).where(eq(tables.users.active, true));
  const base = process.env.APP_BASE_URL ?? "http://localhost:3100";

  let sent = 0;
  const results: { email: string; reason: string }[] = [];
  for (const user of users as any[]) {
    const target = Number(user.weeklyTargetUnits);
    if (target <= 0) continue;

    const weekEntries = await db()
      .select({ units: tables.timeEntries.units, status: tables.timeEntries.status })
      .from(tables.timeEntries)
      .where(
        and(
          eq(tables.timeEntries.userId, user.id),
          gte(tables.timeEntries.date, week.start),
          lte(tables.timeEntries.date, week.end),
        ),
      );
    const logged = weekEntries.reduce((s: number, e: any) => s + Number(e.units), 0);
    const drafts = weekEntries.filter((e: any) => e.status === "draft").length;

    let reason: string | null = null;
    if (logged < target / 2) reason = `only ${logged.toFixed(1)} of ${target} units logged this week`;
    else if (drafts > 0) reason = `${drafts} draft ${drafts === 1 ? "entry" : "entries"} not yet submitted`;
    if (!reason) continue;

    const ok = await sendEmail({
      to: user.email,
      subject: "Sandiva Timesheets — weekly reminder",
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
          <div style="height:4px;background:linear-gradient(90deg,#003D5A,#792C38,#522B4C)"></div>
          <h2 style="color:#003D5A">Timesheet reminder</h2>
          <p>Hi ${user.name},</p>
          <p>Quick nudge: ${reason}. Time not logged is time the firm cannot bill.</p>
          <p style="margin:24px 0"><a href="${base}/log-time" style="background:#B9B400;color:#20200a;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Log time now</a></p>
        </div>`,
    });
    if (ok) sent++;
    results.push({ email: user.email, reason });
  }

  return NextResponse.json({ ok: true, evaluated: users.length, flagged: results.length, sent });
}
