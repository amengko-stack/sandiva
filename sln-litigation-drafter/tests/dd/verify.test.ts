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

  it("throws when a target finding gets no verdict back", async () => {
    const a = finding({ id: "A", severity: "kritis" });
    const b = finding({ id: "B", severity: "kritis" });
    const client = fakeClient(() => ({ verdicts: [{ id: "A", upheld: true }] }));

    await expect(verifyFindings(client, [a, b], "konteks dokumen")).rejects.toThrow(/tidak lengkap/);
  });

  it("throws when the model response is not JSON", async () => {
    const a = finding({ id: "A", severity: "kritis" });
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "bukan json" }],
          stop_reason: "end_turn",
        }),
      },
    } as unknown as Anthropic;

    await expect(verifyFindings(client, [a], "konteks dokumen")).rejects.toThrow();
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
