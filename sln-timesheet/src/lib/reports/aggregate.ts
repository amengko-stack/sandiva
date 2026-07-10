// Report aggregates — one computation shared by the Reports page, the Excel
// export, and Ask-AI (so every surface agrees on the numbers).
//
// Definitions (from the plan):
// - value delivered = billable units x standard rate (write-downs reduce it;
//   actual units preserved separately)
// - WIP           = value of APPROVED, unbilled entries
// - billed        = fee lines on issued (non-void) invoices
// - realization   = billed / value delivered on billed matters
// - margin        = (billed - cost) / billed, cost = actual units x cost rate
//   (IDR; USD matters convert via the settings FX rate, reports only)
// - utilization   = logged units this week / weekly target
import { eq, inArray, ne } from "drizzle-orm";
import { db, tables } from "@/db";
import { priceEntries } from "@/lib/billing/resolve";
import { resolveCostRate, type RateRow } from "@/lib/rates";
import { getSettings } from "@/lib/billing/firm";
import { weekOf } from "@/lib/entries/week";

export interface MatterPerf {
  matterId: number;
  code: string;
  title: string;
  clientName: string;
  feeType: string;
  currency: "IDR" | "USD";
  actualUnits: number;
  valueDelivered: number; // matter currency
  wip: number; // matter currency
  billed: number; // matter currency
  feeAmount: number | null;
  costIdr: number | null; // null when FX needed but unset
  marginPct: number | null;
}

export interface Utilization {
  initials: string;
  name: string;
  role: string;
  weekUnits: number;
  target: number;
  pct: number | null;
}

export async function matterPerformance(): Promise<MatterPerf[]> {
  const settings = await getSettings();
  const entryRows = await db()
    .select({ matterId: tables.timeEntries.matterId })
    .from(tables.timeEntries)
    .where(ne(tables.timeEntries.status, "draft"));
  const matterIds = [...new Set(entryRows.map((r: any) => r.matterId))] as number[];
  if (!matterIds.length) return [];

  const userRates = await db().select().from(tables.userRates);
  const ratesByUser = new Map<number, RateRow[]>();
  for (const r of userRates as any[]) {
    const list = ratesByUser.get(r.userId) ?? [];
    list.push({
      effectiveFrom: r.effectiveFrom,
      billingRateIdr: r.billingRateIdr !== null ? Number(r.billingRateIdr) : null,
      billingRateUsd: r.billingRateUsd !== null ? Number(r.billingRateUsd) : null,
      costRateIdr: r.costRateIdr !== null ? Number(r.costRateIdr) : null,
    });
    ratesByUser.set(r.userId, list);
  }

  const invoices = await db().select().from(tables.invoices).where(eq(tables.invoices.status, "issued"));
  const invIds = invoices.map((i: any) => i.id);
  const feeLines = invIds.length
    ? await db().select().from(tables.invoiceLines).where(inArray(tables.invoiceLines.invoiceId, invIds))
    : [];
  const billedByMatter = new Map<number, number>();
  const invById = new Map(invoices.map((i: any) => [i.id, i]));
  for (const l of feeLines as any[]) {
    if (l.kind !== "fee") continue;
    const inv = invById.get(l.invoiceId) as any;
    billedByMatter.set(inv.matterId, (billedByMatter.get(inv.matterId) ?? 0) + Number(l.amount));
  }

  const out: MatterPerf[] = [];
  for (const matterId of matterIds) {
    const { matter, entries } = await priceEntries(matterId);
    const nonDraft = entries; // priceEntries already includes all; drafts have no billing state issue but exclude:
    const relevant = nonDraft.filter((e) => !Number.isNaN(e.billableUnits));
    const client = await db().query.clients.findFirst({ where: eq(tables.clients.id, matter.clientId) });

    const statuses = await db()
      .select({ id: tables.timeEntries.id, status: tables.timeEntries.status, userId: tables.timeEntries.userId, date: tables.timeEntries.date, units: tables.timeEntries.units })
      .from(tables.timeEntries)
      .where(eq(tables.timeEntries.matterId, matterId));
    const statusById = new Map(statuses.map((s: any) => [s.id, s.status]));

    let valueDelivered = 0;
    let wip = 0;
    let actualUnits = 0;
    let costIdr: number | null = 0;
    for (const e of relevant) {
      const st = statusById.get(e.id);
      if (st === "draft") continue;
      actualUnits += e.actualUnits;
      const amount = e.amount ?? 0;
      if (st === "approved" || st === "billed") valueDelivered += amount;
      if (st === "approved") wip += amount;
      const cr = resolveCostRate({ date: e.date, userRates: ratesByUser.get(e.userId) ?? [] });
      if (costIdr !== null) costIdr = cr !== null ? costIdr + cr * e.actualUnits : costIdr;
    }

    const billed = billedByMatter.get(matterId) ?? 0;
    let marginPct: number | null = null;
    if (billed > 0 && costIdr !== null) {
      let billedIdr = billed;
      if (matter.currency === "USD") {
        if (!settings.fxRateUsdIdr) billedIdr = NaN;
        else billedIdr = billed * settings.fxRateUsdIdr;
      }
      if (Number.isFinite(billedIdr) && billedIdr > 0) {
        marginPct = Math.round(((billedIdr - costIdr) / billedIdr) * 100);
      }
    }

    out.push({
      matterId,
      code: matter.matterCode,
      title: matter.title,
      clientName: client?.name ?? "",
      feeType: matter.feeType,
      currency: matter.currency,
      actualUnits: Math.round(actualUnits * 100) / 100,
      valueDelivered: Math.round(valueDelivered * 100) / 100,
      wip: Math.round(wip * 100) / 100,
      billed: Math.round(billed * 100) / 100,
      feeAmount: matter.feeAmount !== null ? Number(matter.feeAmount) : null,
      costIdr,
      marginPct,
    });
  }
  out.sort((a, b) => b.wip - a.wip);
  return out;
}

export async function utilizationThisWeek(): Promise<Utilization[]> {
  const week = weekOf();
  const users = await db().select().from(tables.users).where(eq(tables.users.active, true));
  const entries = await db()
    .select({ userId: tables.timeEntries.userId, date: tables.timeEntries.date, units: tables.timeEntries.units })
    .from(tables.timeEntries);

  return (users as any[])
    .filter((u) => Number(u.weeklyTargetUnits) > 0)
    .map((u) => {
      const weekUnits = entries
        .filter((e: any) => e.userId === u.id && e.date >= week.start && e.date <= week.end)
        .reduce((s: number, e: any) => s + Number(e.units), 0);
      const target = Number(u.weeklyTargetUnits);
      return {
        initials: u.initials,
        name: u.name,
        role: u.title ?? u.role,
        weekUnits: Math.round(weekUnits * 100) / 100,
        target,
        pct: target > 0 ? Math.round((weekUnits / target) * 100) : null,
      };
    })
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
}

export async function firmTotals() {
  const settings = await getSettings();
  const perf = await matterPerformance();
  const toIdr = (n: number, c: "IDR" | "USD") =>
    c === "IDR" ? n : settings.fxRateUsdIdr ? n * settings.fxRateUsdIdr : 0;
  const wipIdr = perf.reduce((s, m) => s + toIdr(m.wip, m.currency), 0);
  const billedIdr = perf.reduce((s, m) => s + toIdr(m.billed, m.currency), 0);
  const valueIdr = perf.reduce((s, m) => s + toIdr(m.valueDelivered, m.currency), 0);
  const margins = perf.filter((m) => m.marginPct !== null).map((m) => m.marginPct!) ;
  return {
    wipIdr: Math.round(wipIdr),
    billedIdr: Math.round(billedIdr),
    realizationPct: valueIdr > 0 ? Math.round((billedIdr / valueIdr) * 100) : null,
    avgMarginPct: margins.length ? Math.round(margins.reduce((s, v) => s + v, 0) / margins.length) : null,
    perf,
  };
}
