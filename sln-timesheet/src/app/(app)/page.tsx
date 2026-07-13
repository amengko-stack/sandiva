import Link from "next/link";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth/current-user";
import { todayJakarta } from "@/lib/api";
import { weekOf, DAY_LABELS } from "@/lib/entries/week";
import { EntryRow, type EntryRowData } from "@/components/entry-row";
import { AskAI } from "@/components/ask-ai";
import { budgetAlerts, type BudgetAlert } from "@/lib/reports/aggregate";
import { fmtMoney } from "@/lib/billing/firm";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const user = await requireUser();
  const today = todayJakarta();
  const week = weekOf(today);
  const alerts: BudgetAlert[] = user.role === "member" ? [] : await budgetAlerts();

  // Accounting staff aren't fee earners — give them a billing-focused home.
  if (user.role === "accounting") return <AccountingDashboard alerts={alerts} />;

  const rows = await db()
    .select({
      id: tables.timeEntries.id,
      date: tables.timeEntries.date,
      units: tables.timeEntries.units,
      workcode: tables.timeEntries.workcode,
      description: tables.timeEntries.description,
      status: tables.timeEntries.status,
      matterCode: tables.matters.matterCode,
      matterTitle: tables.matters.title,
      clientName: tables.clients.name,
      currency: tables.matters.currency,
      partnerInitials: tables.users.initials,
    })
    .from(tables.timeEntries)
    .innerJoin(tables.matters, eq(tables.timeEntries.matterId, tables.matters.id))
    .innerJoin(tables.clients, eq(tables.matters.clientId, tables.clients.id))
    .innerJoin(tables.users, eq(tables.matters.engagementPartnerId, tables.users.id))
    .where(eq(tables.timeEntries.userId, user.id))
    .orderBy(desc(tables.timeEntries.date), desc(tables.timeEntries.id));

  const weekRows = rows.filter((r: any) => r.date >= week.start && r.date <= week.end);
  const sum = (a: any[]) => a.reduce((s, r) => s + Number(r.units), 0);
  const byStatus = (s: string) => weekRows.filter((r: any) => r.status === s);
  const target = Number(user.weeklyTargetUnits) || 40;
  const logged = sum(weekRows);
  const pct = target > 0 ? Math.round((logged / target) * 100) : 0;
  const drafts = byStatus("draft");
  const perDay = week.days.slice(0, 5).map((d) => sum(weekRows.filter((r: any) => r.date === d)));
  const maxDay = Math.max(4, ...perDay);

  const tiles = [
    {
      label: "Logged this week",
      big: (
        <>
          {logged.toFixed(2)}
          <small className="text-sm font-semibold text-[var(--text-3)]"> / {target} units</small>
        </>
      ),
      meta: `${pct}% of weekly target`,
      bar: Math.min(pct, 100),
    },
    { label: "Pending your submission", big: String(drafts.length), meta: `${sum(drafts).toFixed(2)} units in draft`, href: "/timesheet", action: true },
    { label: "Awaiting approval", big: String(byStatus("submitted").length), meta: `${sum(byStatus("submitted")).toFixed(2)} units with partners` },
    { label: "Approved this week", big: String(byStatus("approved").length), meta: `${sum(byStatus("approved")).toFixed(2)} units billable`, purple: true },
  ];

  return (
    <div className="flex flex-col gap-4">
      {drafts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-card border border-burgundy/30 bg-burgundy/5 px-4 py-2.5 text-[13px] font-medium text-burgundy">
          <span>
            You have <b>{drafts.length} draft {drafts.length === 1 ? "entry" : "entries"}</b> waiting to be submitted.
          </span>
          <span className="flex-1" />
          <Link href="/timesheet" className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold text-[var(--text)]">
            Review &amp; submit
          </Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t, i) => {
          const inner = (
            <div
              key={i}
              className={`relative overflow-hidden rounded-card border p-4 shadow-sm ${
                t.action
                  ? "border-[var(--gold)] bg-gradient-to-b from-[var(--surface)] to-[var(--gold-soft)]"
                  : "border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              {t.purple && <span className="absolute inset-y-0 left-0 w-[3px] bg-plum" />}
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{t.label}</div>
              <div className="num mt-2 text-[26px] font-bold leading-none">{t.big}</div>
              {t.bar !== undefined && (
                <div className="mt-3 h-1.5 overflow-hidden rounded bg-[var(--surface-3)]">
                  <i className="block h-full rounded bg-[var(--navy)]" style={{ width: `${t.bar}%` }} />
                </div>
              )}
              <div className="mt-1 text-xs text-[var(--text-2)]">{t.meta}</div>
            </div>
          );
          return t.href ? (
            <Link key={i} href={t.href}>
              {inner}
            </Link>
          ) : (
            inner
          );
        })}
      </div>

      {alerts.length > 0 && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
            <h2 className="text-sm font-semibold">Fee budget alerts</h2>
            <span className="flex-1" />
            <span className="text-xs text-[var(--text-3)]">value delivered vs agreed fee</span>
          </header>
          {alerts.map((a) => (
            <div key={a.matterId} className="flex flex-wrap items-center gap-2.5 border-t border-[var(--border)] px-4 py-2.5 text-[13px]">
              <span
                className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${
                  a.level === "over" ? "bg-burgundy/15 text-burgundy" : "bg-[var(--gold-soft)] text-[var(--gold-ink)]"
                }`}
              >
                {a.pct}% of fee
              </span>
              <span className="num font-semibold">{a.code}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--text-2)]">
                {a.clientName} · {a.title}
              </span>
              <span className="num text-xs text-[var(--text-3)]">
                {fmtMoney(a.valueDelivered, a.currency)} / {fmtMoney(a.feeAmount, a.currency)}
              </span>
            </div>
          ))}
        </div>
      )}

      {(user.role === "partner" || user.role === "admin") && <AskAI />}

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
            <h2 className="text-sm font-semibold">This week by day</h2>
            <span className="flex-1" />
            <span className="text-xs text-[var(--text-3)]">units logged</span>
          </header>
          <div className="flex h-[150px] items-end gap-3 p-4">
            {perDay.map((v, i) => (
              <div key={i} className="flex h-full flex-1 flex-col items-center gap-1.5">
                <div className="num text-[11px] text-[var(--text-2)]">{v ? v.toFixed(2) : "—"}</div>
                <div className="flex w-full flex-1 items-end justify-center">
                  <div
                    className={`w-3/5 max-w-[34px] rounded-t ${week.days[i] === today ? "bg-[var(--navy)]" : "bg-[var(--navy-300)]"}`}
                    style={{ height: `${Math.round((v / maxDay) * 100)}%`, minHeight: 2 }}
                  />
                </div>
                <div className="text-[11px] font-semibold text-[var(--text-3)]">{DAY_LABELS[i]}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
            <h2 className="text-sm font-semibold">Recent entries</h2>
            <span className="flex-1" />
            <Link href="/timesheet" className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold">
              View all
            </Link>
          </header>
          <div>
            {rows.slice(0, 5).map((r: any) => (
              <EntryRow key={r.id} entry={r as EntryRowData} />
            ))}
            {rows.length === 0 && <p className="p-4 text-sm text-[var(--text-3)]">No entries yet — log your first one.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

// Billing-focused home for the accounting team (not fee earners): outstanding
// AR, matters ready to invoice, fee-budget alerts — no personal timekeeping,
// no margin/cost, no Ask-AI.
async function AccountingDashboard({ alerts }: { alerts: BudgetAlert[] }) {
  const readyCount = (
    await db()
      .selectDistinct({ matterId: tables.timeEntries.matterId })
      .from(tables.timeEntries)
      .where(eq(tables.timeEntries.status, "approved"))
  ).length;

  const invoices = await db()
    .select({ total: tables.invoices.total, currency: tables.invoices.currency, status: tables.invoices.status, paidAt: tables.invoices.paidAt })
    .from(tables.invoices);
  const outstanding = (invoices as any[]).filter((i) => i.status === "issued" && !i.paidAt);
  const outIdr = outstanding.filter((i) => i.currency === "IDR").reduce((s, i) => s + Number(i.total), 0);
  const outUsd = outstanding.filter((i) => i.currency === "USD").reduce((s, i) => s + Number(i.total), 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Link href="/invoices" className="rounded-card border border-[var(--gold)] bg-gradient-to-b from-[var(--surface)] to-[var(--gold-soft)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Matters ready to invoice</div>
          <div className="num mt-2 text-[26px] font-bold">{readyCount}</div>
          <div className="mt-1 text-xs text-[var(--text-2)]">approved time · tap to bill</div>
        </Link>
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Outstanding (unpaid)</div>
          <div className="num mt-2 text-[22px] font-bold">
            {outIdr > 0 ? fmtMoney(outIdr, "IDR") : outUsd > 0 ? "" : "—"}
            {outIdr > 0 && outUsd > 0 && " · "}
            {outUsd > 0 && fmtMoney(outUsd, "USD")}
          </div>
          <div className="mt-1 text-xs text-[var(--text-2)]">{outstanding.length} awaiting collection</div>
        </div>
        <Link href="/reports" className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Reports</div>
          <div className="mt-2 text-[15px] font-semibold">Billing &amp; utilization →</div>
          <div className="mt-1 text-xs text-[var(--text-2)]">export to Excel</div>
        </Link>
      </div>

      {alerts.length > 0 && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
            <h2 className="text-sm font-semibold">Fee budget alerts</h2>
            <span className="flex-1" />
            <span className="text-xs text-[var(--text-3)]">value delivered vs agreed fee</span>
          </header>
          {alerts.map((a) => (
            <div key={a.matterId} className="flex flex-wrap items-center gap-2.5 border-t border-[var(--border)] px-4 py-2.5 text-[13px]">
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${a.level === "over" ? "bg-burgundy/15 text-burgundy" : "bg-[var(--gold-soft)] text-[var(--gold-ink)]"}`}>{a.pct}% of fee</span>
              <span className="num font-semibold">{a.code}</span>
              <span className="min-w-0 flex-1 truncate text-[var(--text-2)]">{a.clientName} · {a.title}</span>
              <span className="num text-xs text-[var(--text-3)]">{fmtMoney(a.valueDelivered, a.currency)} / {fmtMoney(a.feeAmount, a.currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
