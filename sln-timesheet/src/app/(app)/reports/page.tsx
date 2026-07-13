import { redirect } from "next/navigation";
import { and, eq, gte, lte } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth/current-user";
import { firmTotals, utilizationThisWeek } from "@/lib/reports/aggregate";
import { fmtMoney } from "@/lib/billing/firm";
import { FEE_TYPE_LABEL } from "@/lib/constants";
import { todayJakarta } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ReportsPage({ searchParams }: { searchParams: { from?: string; to?: string } }) {
  const user = await requireUser();
  if (user.role === "member") redirect("/");

  const today = todayJakarta();
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = iso.test(searchParams.from ?? "") ? searchParams.from! : today.slice(0, 8) + "01";
  const to = iso.test(searchParams.to ?? "") ? searchParams.to! : today;

  const [totals, utilization] = await Promise.all([firmTotals(), utilizationThisWeek()]);
  const showMargin = user.role === "partner" || user.role === "admin";

  // Period summary — units in the selected range, by fee earner and by matter.
  const period = await db()
    .select({
      units: tables.timeEntries.units,
      status: tables.timeEntries.status,
      who: tables.users.initials,
      whoName: tables.users.name,
      code: tables.matters.matterCode,
      clientName: tables.clients.name,
    })
    .from(tables.timeEntries)
    .innerJoin(tables.users, eq(tables.timeEntries.userId, tables.users.id))
    .innerJoin(tables.matters, eq(tables.timeEntries.matterId, tables.matters.id))
    .innerJoin(tables.clients, eq(tables.matters.clientId, tables.clients.id))
    .where(and(gte(tables.timeEntries.date, from), lte(tables.timeEntries.date, to)));
  const sumBy = (key: (r: any) => string, label: (r: any) => string) => {
    const m = new Map<string, { label: string; units: number; n: number }>();
    for (const r of period as any[]) {
      const k = key(r);
      const cur = m.get(k) ?? { label: label(r), units: 0, n: 0 };
      cur.units += Number(r.units);
      cur.n++;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.units - a.units).slice(0, 12);
  };
  const byEarner = sumBy((r) => r.who, (r) => `${r.who} · ${r.whoName}`);
  const byMatter = sumBy((r) => r.code, (r) => `${r.code} · ${r.clientName}`);
  const periodUnits = (period as any[]).reduce((s, r) => s + Number(r.units), 0);

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-wrap items-center gap-2.5" method="get">
        <label className="text-[12px] font-semibold text-[var(--text-2)]">Period</label>
        <input type="date" name="from" defaultValue={from} className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-sm" />
        <span className="text-[var(--text-3)]">→</span>
        <input type="date" name="to" defaultValue={to} className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-2.5 py-1.5 text-sm" />
        <button type="submit" className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)]">Apply</button>
        <span className="flex-1" />
        <a href={`/api/reports/export?from=${from}&to=${to}`} className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)]">
          ⬇ Export Excel
        </a>
      </form>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Period summary</h2>
          <span className="flex-1" />
          <span className="num text-xs text-[var(--text-3)]">{from} → {to} · {periodUnits.toFixed(2)} units · {period.length} entries</span>
        </header>
        <div className="grid gap-0 sm:grid-cols-2">
          <div className="border-r border-[var(--border)]">
            <p className="px-4 pt-3 text-[10.5px] font-bold uppercase tracking-wider text-[var(--text-3)]">By fee earner</p>
            {byEarner.map((r) => (
              <div key={r.label} className="flex justify-between gap-2 px-4 py-1.5 text-[13px]">
                <span className="truncate">{r.label}</span>
                <span className="num font-semibold">{r.units.toFixed(2)}</span>
              </div>
            ))}
            {byEarner.length === 0 && <p className="px-4 py-2 text-[13px] text-[var(--text-3)]">No entries in this period.</p>}
            <div className="pb-2" />
          </div>
          <div>
            <p className="px-4 pt-3 text-[10.5px] font-bold uppercase tracking-wider text-[var(--text-3)]">By matter</p>
            {byMatter.map((r) => (
              <div key={r.label} className="flex justify-between gap-2 px-4 py-1.5 text-[13px]">
                <span className="truncate">{r.label}</span>
                <span className="num font-semibold">{r.units.toFixed(2)}</span>
              </div>
            ))}
            {byMatter.length === 0 && <p className="px-4 py-2 text-[13px] text-[var(--text-3)]">No entries in this period.</p>}
            <div className="pb-2" />
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Unbilled WIP</div>
          <div className="num mt-2 text-[24px] font-bold">{fmtMoney(totals.wipIdr, "IDR")}</div>
          <div className="mt-1 text-xs text-[var(--text-2)]">approved, not yet invoiced</div>
        </div>
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Realization</div>
          <div className="num mt-2 text-[24px] font-bold">{totals.realizationPct !== null ? `${totals.realizationPct}%` : "—"}</div>
          <div className="mt-1 text-xs text-[var(--text-2)]">billed ÷ value delivered</div>
        </div>
        {showMargin && (
          <div className="relative overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
            <span className="absolute inset-y-0 left-0 w-[3px] bg-plum" />
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Avg margin</div>
            <div className="num mt-2 text-[24px] font-bold text-plum">{totals.avgMarginPct !== null ? `${totals.avgMarginPct}%` : "—"}</div>
            <div className="mt-1 text-xs text-plum">uses confidential cost rates</div>
          </div>
        )}
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Billed to date</div>
          <div className="num mt-2 text-[24px] font-bold">{fmtMoney(totals.billedIdr, "IDR")}</div>
          <div className="mt-1 text-xs text-[var(--text-2)]">issued invoices (fees)</div>
        </div>
      </div>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Matter performance</h2>
          <span className="flex-1" />
          <span className="text-xs text-[var(--text-3)]">amounts in matter currency</span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-[var(--text-3)]">
                <th className="px-4 py-2">Project</th><th className="px-2 py-2">Client</th><th className="px-2 py-2">Fee type</th>
                <th className="px-2 py-2 text-right">Units</th><th className="px-2 py-2 text-right">Value delivered</th>
                <th className="px-2 py-2 text-right">WIP</th><th className="px-2 py-2 text-right">Billed</th>
                <th className="px-2 py-2 text-right">Agreed fee</th>
                {showMargin && <th className="px-2 py-2 text-right text-plum">Margin</th>}
              </tr>
            </thead>
            <tbody>
              {totals.perf.map((m) => (
                <tr key={m.matterId} className="border-t border-[var(--border)]">
                  <td className="num px-4 py-2 font-semibold">{m.code}</td>
                  <td className="max-w-[180px] truncate px-2 py-2">{m.clientName}</td>
                  <td className="px-2 py-2">{FEE_TYPE_LABEL[m.feeType] ?? m.feeType}</td>
                  <td className="num px-2 py-2 text-right">{m.actualUnits.toFixed(2)}</td>
                  <td className="num px-2 py-2 text-right">{fmtMoney(m.valueDelivered, m.currency)}</td>
                  <td className="num px-2 py-2 text-right">{m.wip > 0 ? fmtMoney(m.wip, m.currency) : "—"}</td>
                  <td className="num px-2 py-2 text-right">{m.billed > 0 ? fmtMoney(m.billed, m.currency) : "—"}</td>
                  <td className="num px-2 py-2 text-right">{m.feeAmount !== null ? fmtMoney(m.feeAmount, m.currency) : "—"}</td>
                  {showMargin && (
                    <td className={`num px-2 py-2 text-right font-semibold ${m.marginPct !== null && m.marginPct < 0 ? "text-burgundy" : "text-plum"}`}>
                      {m.marginPct !== null ? `${m.marginPct}%` : "—"}
                    </td>
                  )}
                </tr>
              ))}
              {totals.perf.length === 0 && <tr><td colSpan={9} className="px-4 py-4 text-[var(--text-3)]">No time on the books yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Utilization — this week</h2>
          <span className="flex-1" />
          <span className="text-xs text-[var(--text-3)]">logged ÷ weekly target</span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <tbody>
              {utilization.map((u) => (
                <tr key={u.initials} className="border-t border-[var(--border)]">
                  <td className="px-4 py-2">
                    <span className="mr-2 inline-grid h-6 w-6 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-3)] align-middle text-[9px] font-bold text-[var(--text-2)]">{u.initials}</span>
                    {u.name}
                  </td>
                  <td className="px-2 py-2 text-[var(--text-3)]">{u.role}</td>
                  <td className="num px-2 py-2 text-right">{u.weekUnits.toFixed(1)} / {u.target}</td>
                  <td className="w-[180px] px-4 py-2">
                    <div className="h-1.5 overflow-hidden rounded bg-[var(--surface-3)]">
                      <i className="block h-full rounded" style={{ width: `${Math.min(u.pct ?? 0, 100)}%`, background: (u.pct ?? 0) < 60 ? "var(--burgundy)" : "var(--navy)" }} />
                    </div>
                  </td>
                  <td className="num px-2 py-2 text-right text-xs font-semibold">{u.pct !== null ? `${u.pct}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
