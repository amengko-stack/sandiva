import { describe, it, expect } from "vitest";
import { heuristicTriage, categorize, scoreUrgency, type TriageInput } from "../triage";
import { extractDeadline, extractActionItems } from "../text-utils";

const NOW = new Date("2026-07-11T09:00:00.000Z");

function msg(overrides: Partial<TriageInput>): TriageInput {
  return {
    source: "email",
    sender: "Test Sender",
    sender_role: "other",
    subject: null,
    body: "Hello there.",
    received_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("categorize", () => {
  it("maps sender roles to categories", () => {
    expect(categorize(msg({ sender_role: "court" }))).toBe("court_notice");
    expect(categorize(msg({ sender_role: "opposing_counsel" }))).toBe("opposing_counsel");
    expect(categorize(msg({ sender_role: "client" }))).toBe("client_matter");
    expect(categorize(msg({ sender_role: "associate" }))).toBe("internal");
  });

  it("detects business development inquiries", () => {
    expect(categorize(msg({ body: "We are seeking representation for our company." }))).toBe("business_dev");
  });

  it("detects admin noise", () => {
    expect(categorize(msg({ subject: "Newsletter: CLE credit webinar", body: "Unsubscribe anytime" }))).toBe("admin");
  });
});

describe("scoreUrgency", () => {
  it("rates court hearing notices with near deadlines as critical", () => {
    const input = msg({
      sender_role: "court",
      subject: "Notice of Hearing",
      body: "The hearing is set for tomorrow. Failure to appear may result in sanctions.",
    });
    expect(scoreUrgency(input, NOW).urgency).toBe("critical");
  });

  it("rates client messages with urgent keywords high or critical", () => {
    const input = msg({
      sender_role: "client",
      subject: "URGENT: contract termination",
      body: "We need a response strategy asap. Deadline is Friday.",
    });
    const { urgency } = scoreUrgency(input, NOW);
    expect(["critical", "high"]).toContain(urgency);
  });

  it("caps admin messages at low urgency even with scary words", () => {
    const input = msg({
      body: "Newsletter: our CLE credit webinar on litigation deadlines. Unsubscribe anytime.",
    });
    const { urgency } = scoreUrgency(input, NOW);
    expect(["low", "medium"]).toContain(urgency);
    expect(urgency).not.toBe("critical");
  });

  it("rates mundane internal chatter low", () => {
    const input = msg({ sender_role: "staff", body: "The parking garage is closed this weekend." });
    expect(scoreUrgency(input, NOW).urgency).toBe("low");
  });
});

describe("extractDeadline", () => {
  it("parses month-name dates", () => {
    const iso = extractDeadline("Please respond by July 15", NOW);
    expect(iso).toBeTruthy();
    const d = new Date(iso!);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(15);
  });

  it("parses 'tomorrow' relative to now", () => {
    const iso = extractDeadline("need it by tomorrow", NOW);
    expect(iso).toBeTruthy();
    const d = new Date(iso!);
    const expected = new Date(NOW); expected.setDate(expected.getDate() + 1);
    expect(d.getDate()).toBe(expected.getDate());
  });

  it("parses numeric dates", () => {
    const iso = extractDeadline("filing due 7/20/2026", NOW);
    expect(iso).toBeTruthy();
    expect(new Date(iso!).getDate()).toBe(20);
  });

  it("returns null when no date present", () => {
    expect(extractDeadline("just saying hello", NOW)).toBeNull();
  });

  it("rolls year-less past dates into the future", () => {
    const iso = extractDeadline("hearing set for January 5", NOW);
    expect(iso).toBeTruthy();
    expect(new Date(iso!).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("extractActionItems", () => {
  it("extracts request sentences", () => {
    const items = extractActionItems(
      "Attached is the draft. Could you review and send comments by Thursday? The weather is nice."
    );
    expect(items.length).toBe(1);
    expect(items[0]).toContain("review");
  });

  it("returns empty array for non-actionable text", () => {
    expect(extractActionItems("The meeting went well. Everyone attended.")).toEqual([]);
  });
});

describe("heuristicTriage", () => {
  it("produces a complete triage result deterministically", () => {
    const input = msg({
      sender: "Robert Vance",
      sender_role: "opposing_counsel",
      subject: "Settlement Offer",
      body: "This offer expires at 5:00 PM on July 15. Please respond by the deadline.",
    });
    const a = heuristicTriage(input, NOW);
    const b = heuristicTriage(input, NOW);
    expect(a).toEqual(b);
    expect(a.category).toBe("opposing_counsel");
    expect(["critical", "high"]).toContain(a.urgency);
    expect(a.suggested_deadline).toBeTruthy();
    expect(a.summary).toContain("Robert Vance");
    expect(a.action_items.length).toBeGreaterThan(0);
  });
});
