import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { formatDocBlock } from "@/lib/extract-format";
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

function source(fileName: string, content = "kutipan verbatim"): string {
  return formatDocBlock({
    filename: fileName,
    category: "KRITIS",
    extractionMethod: "synthetic-test",
    characterCount: content.length,
    extractedAt: "2026-09-01T00:00:00.000Z",
    sharePointPath: `/Matter/${fileName}`,
    fileModifiedAt: "2026-09-01T00:00:00.000Z",
    representation: "source",
  }, content);
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

  it("retains refuted targets with a disposition, verifies upheld targets, and leaves non-targets untouched", async () => {
    const a = finding({ id: "A", severity: "kritis", sourceFile: "A.pdf" });
    const b = finding({ id: "B", severity: "kritis", sourceFile: "B.pdf" });
    const c = finding({ id: "C", severity: "minor" });
    const client = fakeClient(() => ({
      verdicts: [
        { id: "A", upheld: true, reason: "supported" },
        { id: "B", upheld: false, reason: "refuted" },
      ],
    }));

    const out = await verifyFindings(client, [a, b, c], source("A.pdf") + source("B.pdf"));

    expect(out).toHaveLength(3);
    const keptA = out.find((f) => f.id === "A");
    expect(keptA?.verified).toBe(true);
    expect(out.find((f) => f.id === "B")?.verification).toEqual({ status: "refuted", reason: "refuted" });
    const untouchedC = out.find((f) => f.id === "C");
    expect(untouchedC).toEqual(c);
  });

  it("targets superseded findings regardless of severity", async () => {
    const s = finding({ id: "S", severity: "material", currencyStatus: "superseded" });
    const client = fakeClient(() => ({ verdicts: [{ id: "S", upheld: true }] }));

    const out = await verifyFindings(client, [s], source("izin.pdf"));

    expect(out).toHaveLength(1);
    expect(out[0].verified).toBe(true);
  });

  it("retains a target with an explicit failure disposition when it gets no verdict back", async () => {
    // A partial verdict list is not a batch failure — the batch succeeded, one
    // finding just has no verdict. That finding must survive, unverified, rather
    // than aborting the run (old behavior) or being dropped.
    const a = finding({ id: "A", severity: "kritis", sourceFile: "A.pdf" });
    const b = finding({ id: "B", severity: "kritis", sourceFile: "B.pdf" });
    const client = fakeClient(() => ({ verdicts: [{ id: "A", upheld: true }] }));

    const out = await verifyFindings(client, [a, b], source("A.pdf") + source("B.pdf"));

    expect(out).toHaveLength(2);
    expect(out.find((f) => f.id === "A")?.verified).toBe(true);
    const keptB = out.find((f) => f.id === "B");
    expect(keptB).toBeDefined();
    expect(keptB?.verified).toBe(false);
    expect(keptB?.verification?.status).toBe("verification_failed");
  });

  it("soft-fails a non-JSON response with an explicit failure disposition instead of throwing", async () => {
    const a = finding({ id: "A", severity: "kritis" });
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: "bukan json" }],
          stop_reason: "end_turn",
        }),
      },
    } as unknown as Anthropic;

    const out = await verifyFindings(client, [a], source("izin.pdf"));

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("A");
    expect(out[0].verified).toBe(false);
    expect(out[0].verification?.status).toBe("verification_failed");
  });

  it("isolates each target in its own verifier call across concurrency waves", async () => {
    const findings: DDFinding[] = [];
    for (let i = 0; i < 12; i++) {
      findings.push(finding({ id: `f${i}`, severity: "kritis", sourceFile: `f${i}.pdf` }));
    }
    let callCount = 0;
    const client = fakeClient((args) => {
      callCount++;
      const prompt = String(args.messages[0].content);
      const ids = Array.from(prompt.matchAll(/"id":"([^"]+)"/g)).map((m) => m[1]);
      return { verdicts: ids.map((id) => ({ id, upheld: true })) };
    });

    const context = findings.map((item) => source(item.sourceFile!)).join("");
    const out = await verifyFindings(client, findings, context);

    expect(callCount).toBe(12);
    expect(out).toHaveLength(12);
    expect(out.every((f) => f.verified)).toBe(true);
  });
});

// Structured H-1 dispositions, not the legacy boolean, record that a finding has
// already completed cited-source verification and may safely survive a reused run.
describe("does not re-verify an existing H-1 disposition", () => {
  const f = (over: Partial<DDFinding> = {}): DDFinding => ({
    id: "f1", entityId: "e1", aspectId: "perizinan", dimension: "risiko",
    severity: "kritis", anchor: "a", sourceFile: "nib.pdf", problem: "p",
    whyItMatters: "w", suggestedFix: "s", verified: false, status: "open",
    ...over,
  });

  it("passes an already-supported finding straight through, with no model call", async () => {
    const client = {
      messages: {
        create: async () => {
          throw new Error("verifyFindings must not call the model here");
        },
      },
    } as unknown as Anthropic;
    const carried = [
      f({ verified: true, verification: { status: "supported", reason: "supported" } }),
      f({ id: "f2", verified: true, verification: { status: "supported", reason: "supported" } }),
    ];
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
    const out = await verifyFindings(client, [f({ verified: false })], source("nib.pdf", "a"));
    expect(called).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0].verification?.status).toBe("refuted");
  });
});
