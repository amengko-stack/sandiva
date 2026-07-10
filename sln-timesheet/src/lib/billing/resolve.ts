// Server-side pricing for a matter's entries: applies the shared rate
// resolver (matter override > user default IN THE MATTER'S CURRENCY,
// effective-date history) and the billable-units rules. Historical entries
// keep their imported rate/amount and are never re-resolved.
import { and, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import {
  billableUnits,
  lineAmount,
  resolveBillingRate,
  type Currency,
  type MatterRateRow,
  type RateRow,
} from "@/lib/rates";

export interface PricedEntry {
  id: number;
  userId: number;
  lawyerName: string;
  date: string;
  workcode: string;
  description: string;
  actualUnits: number;
  billableUnits: number;
  noCharge: boolean;
  rate: number | null; // null = unresolved
  amount: number | null;
  unresolved: boolean;
}

export async function priceEntries(matterId: number, entryIds?: number[]): Promise<{
  matter: any;
  entries: PricedEntry[];
}> {
  const matter = await db().query.matters.findFirst({ where: eq(tables.matters.id, matterId) });
  if (!matter) throw new Error("Matter not found");
  const currency = matter.currency as Currency;

  const where = entryIds?.length
    ? and(eq(tables.timeEntries.matterId, matterId), inArray(tables.timeEntries.id, entryIds))
    : eq(tables.timeEntries.matterId, matterId);

  const rows = await db()
    .select({
      entry: tables.timeEntries,
      lawyerName: tables.users.name,
    })
    .from(tables.timeEntries)
    .innerJoin(tables.users, eq(tables.timeEntries.userId, tables.users.id))
    .where(where);

  const userIds = [...new Set(rows.map((r: any) => r.entry.userId))] as number[];
  const userRates = userIds.length
    ? await db().select().from(tables.userRates).where(inArray(tables.userRates.userId, userIds))
    : [];
  const overrides = await db().select().from(tables.matterRates).where(eq(tables.matterRates.matterId, matterId));

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
  const overridesByUser = new Map<number, MatterRateRow[]>();
  for (const o of overrides as any[]) {
    const list = overridesByUser.get(o.userId) ?? [];
    list.push({ effectiveFrom: o.effectiveFrom, rate: Number(o.rate) });
    overridesByUser.set(o.userId, list);
  }

  const priced: PricedEntry[] = rows.map((r: any) => {
    const e = r.entry;
    const actual = Number(e.units);
    const billable = billableUnits({
      units: actual,
      billedUnits: e.billedUnits !== null ? Number(e.billedUnits) : null,
      noCharge: e.noCharge,
    });

    // Historical rows: imported pricing is authoritative.
    if (e.isHistorical) {
      const rate = e.importedRate !== null ? Number(e.importedRate) : null;
      const amount = e.importedAmount !== null ? Number(e.importedAmount) : rate !== null ? lineAmount(rate, billable) : null;
      return base(e, r.lawyerName, actual, billable, rate, amount, rate === null);
    }

    const resolved = resolveBillingRate({
      date: e.date,
      matterCurrency: currency,
      matterOverrides: overridesByUser.get(e.userId) ?? [],
      userRates: ratesByUser.get(e.userId) ?? [],
    });
    if (resolved.kind === "unresolved") {
      return base(e, r.lawyerName, actual, billable, null, null, true);
    }
    return base(e, r.lawyerName, actual, billable, resolved.rate, lineAmount(resolved.rate, billable), false);
  });

  priced.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  return { matter, entries: priced };
}

function base(
  e: any,
  lawyerName: string,
  actualUnits: number,
  billable: number,
  rate: number | null,
  amount: number | null,
  unresolved: boolean,
): PricedEntry {
  return {
    id: e.id,
    userId: e.userId,
    lawyerName,
    date: e.date,
    workcode: e.workcode,
    description: e.description,
    actualUnits,
    billableUnits: billable,
    noCharge: e.noCharge,
    rate,
    amount,
    unresolved,
  };
}
