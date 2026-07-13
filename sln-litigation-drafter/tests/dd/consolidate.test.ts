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
