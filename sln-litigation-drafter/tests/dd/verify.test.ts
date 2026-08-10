import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { verifyFindings } from "@/lib/dd/verify";
import type { DDFinding } from "@/types/dd";

function finding(over: Partial<DDFinding> = {}): DDFinding {
  return {
    id: "f0",
    entityId: "e1",
    aspectId: "perizinan",
    dimension: "risiko",
    severity: "material",
    anchor: "kutipan verbatim",
    sourceFile: "izin.pdf",
    problem: "masalah",
    whyItMatters: "penting",
    suggestedFix: "perbaikan",
    verified: false,
    status: "open",
    ...over,
  };
}

function fakeClient(payloadFn: (args: any) => object): Anthropic {
  return {
    messages: {
      create: async (args: any) => ({
        content: [{ type: "text", text: JSON.stringify(payloadFn(args)) }],
        stop_reason: "end_turn",
      }),
    },
  } as unknown as Anthropic;
}

describe("verifyFindings", () => {
  it("returns findings as-is and never calls the client when there are no verify targets", async () => {
    const findings = [
      finding({ id: "f1", severity: "material" }),
      finding({ id: "f2", severity: "minor" }),
    ];
    const client = {
      messages: {
        create: async () => {
          throw new Error("must not be called");
        },
      },
    } as unknown as Anthropic;

    const out = await verifyFindings(client, findings, "konteks dokumen");
    expect(out).toEqual(findings);
  });

  it("drops refuted targets, verifies upheld targets, and leaves non-targets untouched", async () => {
    const a = finding({ id: "A", severity: "kritis" });
    const b = finding({ id: "B", severity: "kritis" });
    const c = finding({ id: "C", severity: "minor" });
    const client = fakeClient(() => ({
      verdicts: [
        { id: "A", upheld: true },
        { id: "B", upheld: false },
      ],
    }));

    const out = await verifyFindings(client, [a, b, c], "konteks dokumen");

    expect(out).toHaveLength(2);
    const keptA = out.find((f) => f.id === "A");
    expect(keptA?.verified).toBe(true);
    expect(out.find((f) => f.id === "B")).toBeUndefined();
    const untouchedC = out.find((f) => f.id === "C");
    expect(untouchedC).toEqual(c);
  });

  it("targets superseded findings regardless of severity", async () => {
    const s = finding({ id: "S", severity: "material", currencyStatus: "superseded" });
    const client = fakeClient(() => ({ verdicts: [{ id: "S", upheld: true }] }));

    const out = await verifyFindings(client, [s], "konteks dokumen");

    expect(out).toHaveLength(1);
    expect(out[0].verified).toBe(true);
  });

  it("passes a target through UNVERIFIED (never dropped) when it gets no verdict back", async () => {
    // A partial verdict list is not a batch failure — the batch succeeded, one
    // finding just has no verdict. That finding must survive, unverified, rather
    // than aborting the run (old behavior) or being dropped.
    const a = finding({ id: "A", severity: "kritis" });
    const b = finding({ id: "B", severity: "kritis" });
    const client = fakeClient(() => ({ verdicts: [{ id: "A", upheld: true }] }));

    const out = await verifyFindings(client, [a, b], "konteks dokumen");

    expect(out).toHaveLength(2);
    expect(out.find((f) => f.id === "A")?.verified).toBe(true);
    const keptB = out.find((f) => f.id === "B");
    expect(keptB).toBeDefined();
    expect(keptB?.verified).toBe(false);
  });

  it("soft-fails a non-JSON batch: its findings pass through unverified instead of throwing", async () => {
    const a = finding({ id: "A", severity: "kritis" });
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "bukan json" }],
          stop_reason: "end_turn",
        }),
      },
    } as unknown as Anthropic;

    const out = await verifyFindings(client, [a], "konteks dokumen");

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("A");
    expect(out[0].verified).toBe(false);
  });

  it("batches targets in groups of 10 and verifies survivors across every batch", async () => {
    const findings: DDFinding[] = [];
    for (let i = 0; i < 12; i++) {
      findings.push(finding({ id: `f${i}`, severity: "kritis" }));
    }
    let callCount = 0;
    const client = fakeClient((args) => {
      callCount++;
      const prompt = String(args.messages[0].content);
      const ids = Array.from(prompt.matchAll(/"id":"([^"]+)"/g)).map((m) => m[1]);
      return { verdicts: ids.map((id) => ({ id, upheld: true })) };
    });

    const out = await verifyFindings(client, findings, "konteks dokumen");

    expect(callCount).toBe(2);
    expect(out).toHaveLength(12);
    expect(out.every((f) => f.verified)).toBe(true);
  });
});

// A second Stage 5 run reused every aspect and re-derived nothing, yet three
// findings still vanished: this step re-ran over the carried findings and the
// skeptic reached a different verdict. The most serious findings — the only ones
// verified — were therefore the least stable across runs, and one the lawyer had
// already read could disappear on nothing but a coin landing differently.
describe("does not re-verify what already survived", () => {
  const f = (over: Partial<DDFinding> = {}): DDFinding => ({
    id: "f1", entityId: "e1", aspectId: "perizinan", dimension: "risiko",
    severity: "kritis", anchor: "a", sourceFile: "nib.pdf", problem: "p",
    whyItMatters: "w", suggestedFix: "s", verified: false, status: "open",
    ...over,
  });

  it("passes an already-verified finding straight through, with no model call", async () => {
    const client = {
      messages: {
        create: async () => {
          throw new Error("verifyFindings must not call the model here");
        },
      },
    } as unknown as Anthropic;
    const carried = [f({ verified: true }), f({ id: "f2", verified: true, severity: "kritis" })];
    const out = await verifyFindings(client, carried, "konteks");
    expect(out).toBe(carried);
  });

  it("still verifies a fresh critical finding", async () => {
    let called = 0;
    const client = {
      messages: {
        create: async () => {
          called++;
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: '{"verdicts":[{"id":"f1","upheld":false}]}' }],
          };
        },
      },
    } as unknown as Anthropic;
    const out = await verifyFindings(client, [f({ verified: false })], "konteks");
    expect(called).toBe(1);
    expect(out).toEqual([]); // refuted, so dropped
  });
});
