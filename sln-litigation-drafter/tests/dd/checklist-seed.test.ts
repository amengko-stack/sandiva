import { describe, it, expect } from "vitest";
import { SEED_CHECKLIST } from "@/config/ddChecklist.seed";
import { DD_ASPECTS } from "@/config/ddAspects";
import { DD_TRANSACTION_TYPES } from "@/config/ddTransactionTypes";

describe("seed checklist integrity", () => {
  const aspectIds = new Set(DD_ASPECTS.map((a) => a.id));
  const txnIds = new Set(DD_TRANSACTION_TYPES.map((t) => t.id));
  const allDocs = [
    ...SEED_CHECKLIST.base,
    ...Object.values(SEED_CHECKLIST.overlays).flat(),
  ];

  it("has 10 aspects and 7 transaction types", () => {
    expect(DD_ASPECTS).toHaveLength(10);
    expect(DD_TRANSACTION_TYPES).toHaveLength(7);
  });

  it("every expected doc has a unique id prefixed by its aspect", () => {
    const ids = allDocs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of allDocs) {
      expect(d.id.startsWith(d.aspectId + ".")).toBe(true);
      expect(aspectIds.has(d.aspectId)).toBe(true);
      expect(d.keywords.length).toBeGreaterThan(0);
    }
  });

  it("appliesTo and overlays reference known transaction types", () => {
    for (const d of allDocs) {
      for (const t of d.appliesTo ?? []) expect(txnIds.has(t)).toBe(true);
    }
    for (const k of Object.keys(SEED_CHECKLIST.overlays)) {
      expect(txnIds.has(k as never)).toBe(true);
    }
  });

  it("base covers every aspect and has extraction fields", () => {
    const covered = new Set(SEED_CHECKLIST.base.map((d) => d.aspectId));
    expect(covered.size).toBe(10);
    expect(SEED_CHECKLIST.extractionFields.length).toBeGreaterThanOrEqual(8);
    const fids = SEED_CHECKLIST.extractionFields.map((f) => f.id);
    expect(new Set(fids).size).toBe(fids.length);
  });
});
