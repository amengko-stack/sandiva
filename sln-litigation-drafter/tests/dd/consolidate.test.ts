import { describe, it, expect } from "vitest";
import { computeAspectRollup } from "@/lib/dd/consolidate";
import type { DDGapItem } from "@/types/dd";

const gap = (aspectId: DDGapItem["aspectId"], status: DDGapItem["status"]): DDGapItem => ({
  entityId: "e1", aspectId, expectedDocId: `${aspectId}.x`, expectedLabel: "x",
  status, matchedFiles: [], severity: "material", note: "",
});

describe("computeAspectRollup", () => {
  it("aggregates counts per aspect across entities", () => {
    const rollup = computeAspectRollup({
      e1: [gap("perizinan", "present"), gap("perizinan", "missing"), gap("perkara", "expired")],
      e2: [gap("perizinan", "incomplete"), gap("perkara", "not_applicable")],
    });
    const izin = rollup.find((r) => r.aspectId === "perizinan")!;
    expect(izin).toMatchObject({ totalExpected: 3, present: 1, missing: 1, incomplete: 1, expired: 0, notApplicable: 0 });
    const perkara = rollup.find((r) => r.aspectId === "perkara")!;
    expect(perkara).toMatchObject({ totalExpected: 2, expired: 1, notApplicable: 1 });
    // sorted by aspect order — perizinan (index 3) before perkara (index 9)
    expect(rollup.map((r) => r.aspectId)).toEqual(["perizinan", "perkara"]);
  });
});

// The rollup counted by a chain of else-ifs ending in a catch-all `else` that
// incremented notApplicable. A new status therefore did not fail to be counted — it
// was counted as the one thing it is the opposite of: "does not apply to this entity"
// rather than "may well apply and we cannot yet tell".
describe("the unreadable status in the rollup", () => {
  it("counts it in its own column, not as not-applicable", () => {
    const izin = computeAspectRollup({
      e1: [gap("perizinan", "unreadable"), gap("perizinan", "not_applicable")],
    }).find((r) => r.aspectId === "perizinan")!;
    expect(izin.unreadable).toBe(1);
    expect(izin.notApplicable).toBe(1);
  });

  it("keeps every item accounted for exactly once", () => {
    const statuses: DDGapItem["status"][] = [
      "present", "missing", "unreadable", "incomplete", "expired", "not_applicable",
    ];
    const r = computeAspectRollup({ e1: statuses.map((st) => gap("perizinan", st)) }).find(
      (x) => x.aspectId === "perizinan"
    )!;
    const summed =
      r.present + r.missing + (r.unreadable ?? 0) + r.incomplete + r.expired + r.notApplicable;
    expect(summed).toBe(r.totalExpected);
    expect(r.totalExpected).toBe(statuses.length);
  });
});
