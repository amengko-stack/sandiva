import { describe, expect, it } from "vitest";
import {
  billableUnits,
  lineAmount,
  ppnAmount,
  resolveBillingRate,
  resolveCostRate,
  roundUnits,
  type RateRow,
} from "./rates";

const userRates: RateRow[] = [
  { effectiveFrom: "2025-01-01", billingRateIdr: 900_000, billingRateUsd: 60, costRateIdr: 350_000 },
  { effectiveFrom: "2026-07-01", billingRateIdr: 1_000_000, billingRateUsd: 65, costRateIdr: 400_000 },
];

describe("resolveBillingRate", () => {
  it("uses the matter override when one is in effect", () => {
    const r = resolveBillingRate({
      date: "2026-07-09",
      matterCurrency: "IDR",
      matterOverrides: [{ effectiveFrom: "2026-01-01", rate: 1_250_000 }],
      userRates,
    });
    expect(r).toEqual({ kind: "resolved", rate: 1_250_000, source: "matter_override" });
  });

  it("falls back to the user default in the matter's currency", () => {
    const idr = resolveBillingRate({ date: "2026-07-09", matterCurrency: "IDR", matterOverrides: [], userRates });
    const usd = resolveBillingRate({ date: "2026-07-09", matterCurrency: "USD", matterOverrides: [], userRates });
    expect(idr).toEqual({ kind: "resolved", rate: 1_000_000, source: "user_default" });
    expect(usd).toEqual({ kind: "resolved", rate: 65, source: "user_default" });
  });

  it("bills old entries at the rate in force THEN, not today's", () => {
    const r = resolveBillingRate({ date: "2026-06-30", matterCurrency: "IDR", matterOverrides: [], userRates });
    expect(r).toEqual({ kind: "resolved", rate: 900_000, source: "user_default" });
  });

  it("is unresolved when the user has no rate in the matter's currency (never silent FX)", () => {
    const noUsd: RateRow[] = [
      { effectiveFrom: "2025-01-01", billingRateIdr: 900_000, billingRateUsd: null, costRateIdr: null },
    ];
    const r = resolveBillingRate({ date: "2026-07-09", matterCurrency: "USD", matterOverrides: [], userRates: noUsd });
    expect(r).toEqual({ kind: "unresolved" });
  });

  it("is unresolved before any rate takes effect", () => {
    const r = resolveBillingRate({ date: "2024-12-31", matterCurrency: "IDR", matterOverrides: [], userRates });
    expect(r).toEqual({ kind: "unresolved" });
  });

  it("ignores overrides that only take effect later", () => {
    const r = resolveBillingRate({
      date: "2026-07-09",
      matterCurrency: "IDR",
      matterOverrides: [{ effectiveFrom: "2026-08-01", rate: 2_000_000 }],
      userRates,
    });
    expect(r).toEqual({ kind: "resolved", rate: 1_000_000, source: "user_default" });
  });
});

describe("resolveCostRate", () => {
  it("returns the cost rate in effect for the date", () => {
    expect(resolveCostRate({ date: "2026-07-09", userRates })).toBe(400_000);
    expect(resolveCostRate({ date: "2026-06-01", userRates })).toBe(350_000);
  });
  it("returns null when none applies", () => {
    expect(resolveCostRate({ date: "2024-01-01", userRates })).toBeNull();
  });
});

describe("roundUnits", () => {
  it("2dp keeps the firm's invoice format exactly (0.17 survives round-trip)", () => {
    expect(roundUnits(0.17)).toBe(0.17);
    expect(roundUnits(0.08)).toBe(0.08);
    expect(roundUnits(10 / 60)).toBe(0.17); // 10 minutes
    expect(roundUnits(5 / 60)).toBe(0.08); // 5 minutes
  });
  it("6min rounds UP to the next 0.1", () => {
    expect(roundUnits(0.01, "6min")).toBe(0.1);
    expect(roundUnits(1.11, "6min")).toBe(1.2);
    expect(roundUnits(1.2, "6min")).toBe(1.2); // exact boundary does not bump
  });
});

describe("billableUnits", () => {
  it("no-charge zeroes the line but preserves nothing else", () => {
    expect(billableUnits({ units: 3, billedUnits: null, noCharge: true })).toBe(0);
  });
  it("partner write-down wins over actual units", () => {
    expect(billableUnits({ units: 5, billedUnits: 3, noCharge: false })).toBe(3);
  });
  it("defaults to rounded actual units", () => {
    expect(billableUnits({ units: 0.166666, billedUnits: null, noCharge: false })).toBe(0.17);
  });
});

describe("invoice math (sample invoice reproduction)", () => {
  // The real Statement_invoice.pdf: 0.94 units at Rp 1,000,000 -> Rp 940,000
  // + PPN 11% (Rp 103,400) = Rp 1,043,400.
  it("matches the sample invoice totals exactly", () => {
    const lines = [0.08, 0.1, 0.17, 0.25, 0.17, 0.17];
    const subtotal = lines.reduce((s, u) => s + lineAmount(1_000_000, u), 0);
    expect(subtotal).toBe(940_000);
    expect(ppnAmount(subtotal, 11)).toBe(103_400);
    expect(subtotal + ppnAmount(subtotal, 11)).toBe(1_043_400);
  });
});
