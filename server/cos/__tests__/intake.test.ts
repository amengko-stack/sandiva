import { describe, it, expect } from "vitest";
import { heuristicIntakeAnalysis, detectPracticeArea, findConflicts } from "../intake";
import type { CosMatter } from "@shared/schema";

const MATTERS: CosMatter[] = [
  {
    id: 1, client_name: "Meridian Health Systems",
    matter_name: "Meridian Health v. DataBridge Analytics",
    practice_area: "litigation", adverse_party: "DataBridge Analytics",
    status: "active", opened_at: "2026-01-01T00:00:00.000Z",
  },
];

describe("detectPracticeArea", () => {
  it("detects employment matters", () => {
    expect(detectPracticeArea("Employee was wrongfully terminated and alleges discrimination and unpaid overtime.")).toBe("employment");
  });
  it("detects contract matters", () => {
    expect(detectPracticeArea("Vendor breached the supply agreement and refuses payment of invoices.")).toBe("contract");
  });
  it("detects IP matters", () => {
    expect(detectPracticeArea("Competitor is infringing our registered trademark and stole trade secret designs.")).toBe("intellectual_property");
  });
  it("falls back to general", () => {
    expect(detectPracticeArea("We would like advice about something.")).toBe("general");
  });
});

describe("findConflicts", () => {
  it("flags when the prospective client is an adverse party in an existing matter", () => {
    const flags = findConflicts(
      { client_name: "DataBridge Analytics", matter_description: "Needs help with a lease dispute." },
      MATTERS
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]).toContain("DataBridge");
  });

  it("flags when the description mentions an existing client", () => {
    const flags = findConflicts(
      { client_name: "Acme Corp", matter_description: "We are in a dispute with Meridian Health Systems over billing." },
      MATTERS
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]).toContain("Meridian Health Systems");
  });

  it("returns empty for unrelated intakes", () => {
    const flags = findConflicts(
      { client_name: "Acme Corp", matter_description: "Trademark filing for a new product line." },
      MATTERS
    );
    expect(flags).toEqual([]);
  });
});

describe("heuristicIntakeAnalysis", () => {
  const input = {
    client_name: "Brightline Logistics",
    matter_description:
      "Former VP was terminated for cause and threatens a wrongful termination and discrimination lawsuit. He took confidential data to competitor DataBridge Analytics. Board meets next week and there is a filing deadline.",
  };

  it("builds a full initial matter view", () => {
    const a = heuristicIntakeAnalysis(input, MATTERS);
    expect(a.practice_area).toBe("employment");
    expect(a.key_issues.length).toBeGreaterThan(0);
    expect(a.conflict_flags.length).toBeGreaterThan(0); // mentions DataBridge
    expect(a.urgency).toBe("high"); // "deadline"
    expect(a.recommended_actions.length).toBeGreaterThan(2);
    expect(a.recommended_actions[0]).toContain("conflict");
    expect(a.summary).toContain("Brightline Logistics");
  });

  it("is deterministic", () => {
    expect(heuristicIntakeAnalysis(input, MATTERS)).toEqual(heuristicIntakeAnalysis(input, MATTERS));
  });

  it("marks simple clean intakes low urgency with no conflicts", () => {
    const a = heuristicIntakeAnalysis(
      { client_name: "Fresh Co", matter_description: "Wants a standard office lease reviewed." },
      MATTERS
    );
    expect(a.conflict_flags).toEqual([]);
    expect(a.urgency).toBe("low");
  });
});
