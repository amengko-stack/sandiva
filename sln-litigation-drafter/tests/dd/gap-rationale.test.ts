import { describe, it, expect } from "vitest";
import { gapRationaleFor } from "@/config/ddGapRationale";

// The gap rationale is not commentary: gap-engine.ts:180 splices legalBasis
// straight into whyItMatters, so whatever it says about the statute reaches the
// client report as the firm's statement of law.
//
// Pasal 142 ayat (3) does not oblige the RUPS to appoint a liquidator in the
// dissolution resolution. It supplies the fallback for when it does not:
// "...dan RUPS tidak menunjuk likuidator, Direksi bertindak selaku likuidator."
// Reading it the other way round is the exact error lib/dd/statute.ts was
// written to document, and it reappeared here in a different file.
//
// The only place a resolution "sekaligus" appoints a liquidator is Pasal 146
// ayat (2), and that is a court-ordered dissolution, not a RUPS one.
describe("dissolution RUPS gap rationale, measured against UUPT", () => {
  it("does not make the RUPS resolution appoint the liquidator", () => {
    const r = gapRationaleFor("pengurus.rups_pembubaran");
    expect(r).toBeDefined();
    expect(r!.legalBasis).not.toMatch(/sekaligus menunjuk likuidator/i);
  });

  it("states the Direksi fallback the article actually provides", () => {
    const r = gapRationaleFor("pengurus.rups_pembubaran");
    expect(r!.legalBasis).toMatch(/Direksi bertindak selaku likuidator/i);
    expect(r!.legalRefs.join(" ")).toContain("Pasal 142 ayat (3)");
  });
});
