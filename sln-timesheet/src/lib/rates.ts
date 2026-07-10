// Rate resolution + billable-units math — the single source of truth used by
// billing drafts, invoices, and every report. See plan: "Rate resolver".
//
// Rules (locked in the plan):
// - A matter bills in ITS currency. The resolver picks the user's rate in that
//   currency; a missing rate is `unresolved` — never 0, never silent FX.
// - Per-matter override beats the user default; both carry effective_from
//   history: the rate in effect for a date is the row with the latest
//   effective_from <= that date.
// - Historical (imported) entries keep their imported rate and are never
//   re-resolved — callers must check `isHistorical` before calling this.

export type Currency = "IDR" | "USD";

export interface RateRow {
  /** ISO date (yyyy-mm-dd) this rate takes effect. */
  effectiveFrom: string;
  billingRateIdr: number | null;
  billingRateUsd: number | null;
  costRateIdr: number | null;
}

export interface MatterRateRow {
  effectiveFrom: string;
  /** In the matter's currency. */
  rate: number;
}

export type ResolvedRate =
  | { kind: "resolved"; rate: number; source: "matter_override" | "user_default" }
  | { kind: "unresolved" };

/** Latest row whose effectiveFrom <= date, or undefined. */
function inEffect<T extends { effectiveFrom: string }>(rows: T[], date: string): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (row.effectiveFrom <= date && (!best || row.effectiveFrom > best.effectiveFrom)) {
      best = row;
    }
  }
  return best;
}

export function resolveBillingRate(args: {
  date: string; // entry date, ISO
  matterCurrency: Currency;
  matterOverrides: MatterRateRow[]; // this user on this matter
  userRates: RateRow[]; // this user's default-rate history
}): ResolvedRate {
  const override = inEffect(args.matterOverrides, args.date);
  if (override) return { kind: "resolved", rate: override.rate, source: "matter_override" };

  const userRate = inEffect(args.userRates, args.date);
  if (userRate) {
    const rate = args.matterCurrency === "USD" ? userRate.billingRateUsd : userRate.billingRateIdr;
    if (rate !== null && rate > 0) return { kind: "resolved", rate, source: "user_default" };
  }
  return { kind: "unresolved" };
}

export function resolveCostRate(args: { date: string; userRates: RateRow[] }): number | null {
  const row = inEffect(args.userRates, args.date);
  return row?.costRateIdr ?? null;
}

// ---------------------------------------------------------------------------
// Units math
// ---------------------------------------------------------------------------

export type RoundingRule = "2dp" | "6min";

/** Round actual units per the firm rule (default 2dp; "6min" rounds UP to 0.1). */
export function roundUnits(units: number, rule: RoundingRule = "2dp"): number {
  if (rule === "6min") return Math.ceil(units * 10 - 1e-9) / 10;
  return Math.round(units * 100) / 100;
}

/**
 * Billable units for an entry: no-charge zeroes it; a partner write-down
 * (billedUnits) wins; otherwise the rounded actual units.
 */
export function billableUnits(entry: {
  units: number;
  billedUnits: number | null;
  noCharge: boolean;
  rule?: RoundingRule;
}): number {
  if (entry.noCharge) return 0;
  if (entry.billedUnits !== null) return roundUnits(entry.billedUnits, entry.rule ?? "2dp");
  return roundUnits(entry.units, entry.rule ?? "2dp");
}

/** Line amount = rate x billable units, rounded to 2dp of the currency. */
export function lineAmount(rate: number, units: number): number {
  return Math.round(rate * units * 100) / 100;
}

/** PPN on a subtotal, 2dp. Rate is a percentage (e.g. 11). */
export function ppnAmount(subtotal: number, ppnRatePct: number): number {
  return Math.round(subtotal * ppnRatePct) / 100;
}
