import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { formatDocBlock } from "@/lib/extract-format";
import { consolidate } from "@/lib/dd/consolidate";
import { renderFindingsTable } from "@/lib/dd/findings-render";
import { diffAgainstBaseline, snapshotBaseline } from "@/lib/dd/supplement";
import { verifyFindings } from "@/lib/dd/verify";
import type { DDClassifiedDoc, DDFinding, DDTransaction } from "@/types/dd";

function finding(over: Partial<DDFinding> = {}): DDFinding {
  return {
    id: "f0",
    entityId: "e1",
    aspectId: "perizinan",
    dimension: "risiko",
    severity: "kritis",
    anchor: "izin berlaku sampai 31 Desember 2030",
    sourceFile: "Document A.pdf",
    problem: "Izin akan berakhir sebelum transaksi selesai.",
    whyItMatters: "Operasi memerlukan izin yang berlaku.",
    suggestedFix: "Perpanjang izin sebelum penutupan.",
    verified: false,
    status: "open",
    ...over,
  };
}

function sourceBlock(fileName: string, content: string, path = `/Matter/${fileName}`): string {
  return formatDocBlock(
    {
      filename: fileName,
      category: "KRITIS",
      extractionMethod: "synthetic-test",
      characterCount: content.length,
      extractedAt: "2026-09-01T00:00:00.000Z",
      sharePointPath: path,
      fileModifiedAt: "2026-09-01T00:00:00.000Z",
      representation: "source",
    },
    content,
  );
}

function fakeClient(
  reply: (prompt: string, call: number) => { id: string; upheld: boolean; reason: string },
  prompts: string[],
): Anthropic {
  return {
    messages: {
      create: async (args: any) => {
        const prompt = String(args.messages[0].content);
        prompts.push(prompt);
        const verdict = reply(prompt, prompts.length - 1);
        return {
          content: [{ type: "text", text: JSON.stringify({ verdicts: [verdict] }) }],
          stop_reason: "end_turn",
        };
      },
    },
  } as unknown as Anthropic;
}

const classifiedA: DDClassifiedDoc = {
  fileName: "Document A.pdf",
  entityId: "e1",
  aspectId: "perizinan",
  expectedDocId: null,
  docLabel: "Document A",
  docDate: null,
  parties: [],
  summary: "Synthetic document.",
  confidence: "tinggi",
  reasoning: "Synthetic fixture.",
};

describe("H-1 adversarial verifier source integrity", () => {
  it("Fixture A — verifies a supported finding against its cited source-derived document", async () => {
    const prompts: string[] = [];
    const client = fakeClient(
      () => ({ id: "A", upheld: true, reason: "The cited licence supports the finding." }),
      prompts,
    );
    const combined =
      sourceBlock("Document A.pdf", "A_ONLY_MARKER izin berlaku sampai 31 Desember 2030") +
      sourceBlock("Document B.pdf", "B_ONLY_MARKER unrelated wording");

    const [out] = await verifyFindings(client, [finding({ id: "A" })], combined);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("AUTHORITATIVE CITED SOURCE");
    expect(prompts[0]).toContain("Filename: Document A.pdf");
    expect(prompts[0]).toContain("A_ONLY_MARKER");
    expect(prompts[0]).not.toContain("B_ONLY_MARKER");
    expect(out.verified).toBe(true);
    expect(out.verification).toEqual({
      status: "supported",
      reason: "The cited licence supports the finding.",
    });
  });

  it("Fixture B — reaches the cited source beyond the former 50,000-character corpus prefix", async () => {
    const prompts: string[] = [];
    const client = fakeClient(
      (prompt) => ({
        id: "LATE",
        upheld: prompt.includes("LATE_SOURCE_SUPPORT"),
        reason: "The late cited source supports the finding.",
      }),
      prompts,
    );
    const combined =
      sourceBlock("Unrelated.pdf", `UNRELATED_PREFIX_${"x".repeat(60_000)}`) +
      sourceBlock("Late Source.pdf", "LATE_SOURCE_SUPPORT izin berlaku sampai 31 Desember 2030");

    const [out] = await verifyFindings(
      client,
      [finding({ id: "LATE", sourceFile: "Late Source.pdf" })],
      combined,
    );

    expect(prompts[0]).toContain("LATE_SOURCE_SUPPORT");
    expect(prompts[0]).not.toContain("UNRELATED_PREFIX");
    expect(out.verification?.status).toBe("supported");
    expect(out.verified).toBe(true);
  });

  it("Fixture C — cannot use matching wording from the wrong document", async () => {
    const prompts: string[] = [];
    const client = fakeClient(
      (prompt) => ({
        id: "WRONG-DOC",
        upheld: prompt.includes("CLAIM_EXISTS_ONLY_IN_B"),
        reason: "The cited document does not contain the claimed proposition.",
      }),
      prompts,
    );
    const combined =
      sourceBlock("Document A.pdf", "A does not contain the claimed proposition.") +
      sourceBlock("Document B.pdf", "CLAIM_EXISTS_ONLY_IN_B");

    const [out] = await verifyFindings(client, [finding({ id: "WRONG-DOC" })], combined);

    expect(prompts[0]).toContain("Filename: Document A.pdf");
    expect(prompts[0]).not.toContain("CLAIM_EXISTS_ONLY_IN_B");
    expect(out.verification?.status).toBe("refuted");
    expect(out.verified).toBe(false);
  });

  it("Fixture D — records an unresolved source without calling the model or substituting another document", async () => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls++;
          throw new Error("A missing source must not reach the model.");
        },
      },
    } as unknown as Anthropic;
    const combined = sourceBlock("Document B.pdf", "UNRELATED_SOURCE_EVIDENCE");

    const [out] = await verifyFindings(
      client,
      [finding({ id: "MISSING", sourceFile: "Missing.pdf" })],
      combined,
    );

    expect(calls).toBe(0);
    expect(out.verified).toBe(false);
    expect(out.verification).toEqual({
      status: "source_unresolved",
      reason: "Cited source document could not be resolved.",
    });
  });

  it("Fixture E — retains a refuted finding and reason for audit but excludes it from established report findings", async () => {
    const prompts: string[] = [];
    const client = fakeClient(
      () => ({ id: "REFUTED", upheld: false, reason: "Claim is not supported by the cited deed." }),
      prompts,
    );

    const out = await verifyFindings(
      client,
      [finding({ id: "REFUTED" })],
      sourceBlock("Document A.pdf", "No support for the finding."),
    );

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("REFUTED");
    expect(out[0].verification).toEqual({
      status: "refuted",
      reason: "Claim is not supported by the cited deed.",
    });
    expect(renderFindingsTable(out)).toEqual([]);
  });

  it("Fixture F — isolates two findings so each verifier request receives only its own cited source", async () => {
    const prompts: string[] = [];
    const client = fakeClient(
      (prompt) => ({
        id: prompt.includes('"id":"A"') ? "A" : "B",
        upheld: true,
        reason: "Supported by the isolated cited source.",
      }),
      prompts,
    );
    const combined =
      sourceBlock("Document A.pdf", "A_SOURCE_MARKER") +
      sourceBlock("Document B.pdf", "B_SOURCE_MARKER");

    const out = await verifyFindings(
      client,
      [
        finding({ id: "A", sourceFile: "Document A.pdf" }),
        finding({ id: "B", sourceFile: "Document B.pdf" }),
      ],
      combined,
    );

    expect(prompts).toHaveLength(2);
    const promptA = prompts.find((prompt) => prompt.includes('"id":"A"')) ?? "";
    const promptB = prompts.find((prompt) => prompt.includes('"id":"B"')) ?? "";
    expect(promptA).toContain("A_SOURCE_MARKER");
    expect(promptA).not.toContain("B_SOURCE_MARKER");
    expect(promptB).toContain("B_SOURCE_MARKER");
    expect(promptB).not.toContain("A_SOURCE_MARKER");
    expect(out.map((item) => item.verification?.status)).toEqual(["supported", "supported"]);
  });

  it("Fixture G — preserves a supported finding's material content", async () => {
    const prompts: string[] = [];
    const original = finding({ id: "SUPPORTED", legalConsequence: "Konsekuensi kontraktual." });
    const client = fakeClient(
      () => ({ id: "SUPPORTED", upheld: true, reason: "The quote supports the finding." }),
      prompts,
    );

    const [out] = await verifyFindings(
      client,
      [original],
      sourceBlock("Document A.pdf", "izin berlaku sampai 31 Desember 2030"),
    );

    expect(out).toMatchObject({
      ...original,
      verified: true,
      verification: { status: "supported", reason: "The quote supports the finding." },
    });
  });

  it("migrates a legacy verified finding through the exact cited source into a supported disposition", async () => {
    const prompts: string[] = [];
    const client = fakeClient(
      () => ({ id: "LEGACY", upheld: true, reason: "The exact cited source supports the legacy finding." }),
      prompts,
    );
    const combined =
      sourceBlock("Document A.pdf", "LEGACY_EXACT_SOURCE_MARKER") +
      sourceBlock("Document B.pdf", "UNRELATED_LEGACY_MARKER");

    const [out] = await verifyFindings(
      client,
      [finding({ id: "LEGACY", verified: true, verification: undefined })],
      combined,
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Filename: Document A.pdf");
    expect(prompts[0]).toContain("LEGACY_EXACT_SOURCE_MARKER");
    expect(prompts[0]).not.toContain("UNRELATED_LEGACY_MARKER");
    expect(out.verified).toBe(true);
    expect(out.verification).toEqual({
      status: "supported",
      reason: "The exact cited source supports the legacy finding.",
    });
  });

  it("does not call the verifier again for an existing supported disposition", async () => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls++;
          throw new Error("A structured supported disposition must not be re-verified.");
        },
      },
    } as unknown as Anthropic;
    const carried = finding({
      id: "ALREADY-SUPPORTED",
      verified: true,
      verification: { status: "supported", reason: "Previously supported." },
    });

    const [out] = await verifyFindings(
      client,
      [carried],
      sourceBlock("Document A.pdf", "SOURCE_PRESENT"),
    );

    expect(calls).toBe(0);
    expect(out).toBe(carried);
  });

  it.each(["refuted", "source_unresolved", "verification_failed"] as const)(
    "does not call the verifier again for an existing %s disposition",
    async (status) => {
      let calls = 0;
      const client = {
        messages: {
          create: async () => {
            calls++;
            throw new Error("An existing structured disposition must not be re-verified.");
          },
        },
      } as unknown as Anthropic;
      const carried = finding({
        id: `ALREADY-${status}`,
        verified: true,
        verification: { status, reason: "Previously resolved by H-1." },
      });

      const [out] = await verifyFindings(
        client,
        [carried],
        sourceBlock("Document A.pdf", "SOURCE_PRESENT"),
      );

      expect(calls).toBe(0);
      expect(out).toBe(carried);
    },
  );

  it("migrates a legacy verified finding with no resolvable source to non-reportable source_unresolved", async () => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls++;
          throw new Error("An unresolved source must not reach the model.");
        },
      },
    } as unknown as Anthropic;

    const [out] = await verifyFindings(
      client,
      [finding({ id: "LEGACY-UNRESOLVED", verified: true, verification: undefined })],
      sourceBlock("Document B.pdf", "UNRELATED_SOURCE"),
    );

    expect(calls).toBe(0);
    expect(out.verified).toBe(false);
    expect(out.verification).toEqual({
      status: "source_unresolved",
      reason: "Cited source document could not be resolved.",
    });
    expect(renderFindingsTable([out])).toEqual([]);
  });

  it("preserves the C-2 invariant by excluding a model-derived summary from authoritative evidence", async () => {
    const prompts: string[] = [];
    const client = fakeClient(
      (prompt) => ({
        id: "C2",
        upheld: prompt.includes("DERIVED_SUMMARY_SUPPORT"),
        reason: "Only a derived summary contained the proposition.",
      }),
      prompts,
    );
    const combined =
      "DERIVED_SUMMARY_SUPPORT — model-generated structured summary, not a source document.\n" +
      sourceBlock("Document A.pdf", "The source-derived document does not support the proposition.");

    const [out] = await verifyFindings(client, [finding({ id: "C2" })], combined);

    expect(prompts[0]).not.toContain("DERIVED_SUMMARY_SUPPORT");
    expect(prompts[0]).toContain("The source-derived document does not support the proposition.");
    expect(out.verification?.status).toBe("refuted");
  });

  it("excludes a refuted finding from an issued-report baseline and new-document supplement findings", () => {
    const refuted = finding({
      id: "REFUTED-SUPPLEMENT",
      verification: { status: "refuted", reason: "Not supported by the cited source." },
    });
    const baseline = snapshotBaseline({
      entityId: "e1",
      issuedAtISO: "2026-08-01T00:00:00.000Z",
      cutoffDateISO: "2026-08-01",
      classified: [],
      contentByFile: new Map(),
      gaps: [],
      findings: [refuted],
    });
    const diff = diffAgainstBaseline(baseline, {
      cutoffDateISO: "2026-09-01",
      classified: [classifiedA],
      contentByFile: new Map([["Document A.pdf", "new source text"]]),
      gaps: [],
      findings: [refuted],
    });

    expect(baseline.findings).toEqual([]);
    expect(diff.findingsFromNewDocuments).toEqual([]);
    expect(diff.findingsCarriedForward).toBe(0);
  });

  it("accounts for a previously issued finding that is now refuted as no longer established", () => {
    const prior = finding({ id: "PRIOR" });
    const baseline = snapshotBaseline({
      entityId: "e1",
      issuedAtISO: "2026-08-01T00:00:00.000Z",
      cutoffDateISO: "2026-08-01",
      classified: [classifiedA],
      contentByFile: new Map([["Document A.pdf", "old source text"]]),
      gaps: [],
      findings: [prior],
    });
    const current = {
      ...prior,
      verification: { status: "refuted" as const, reason: "Not supported by the cited source." },
    };

    const diff = diffAgainstBaseline(baseline, {
      cutoffDateISO: "2026-09-01",
      classified: [classifiedA],
      contentByFile: new Map([["Document A.pdf", "old source text"]]),
      gaps: [],
      findings: [current],
    });

    expect(diff.findingsCarriedForward).toBe(0);
    expect(diff.findingsNoLongerRaised.map((item) => item.id)).toEqual(["PRIOR"]);
  });

  it("does not let a retained refutation seed cross-entity consolidation findings", async () => {
    let prompt = "";
    const client = {
      messages: {
        create: async (args: any) => {
          prompt = String(args.messages[0].content);
          return {
            content: [{ type: "text", text: '{"findings":[]}' }],
            stop_reason: "end_turn",
          };
        },
      },
    } as unknown as Anthropic;
    const transaction: DDTransaction = {
      id: "session-h1",
      name: "Synthetic H-1 Matter",
      type: "akuisisi_saham",
      clientRole: "pembeli",
      cutoffDateISO: "2026-09-01",
      checklistVersion: "synthetic",
      entities: [
        { id: "e1", name: "PT Alpha", role: "target", dataRoomPath: "/Matter/Alpha", files: [] },
        { id: "e2", name: "PT Beta", role: "penjual", dataRoomPath: "/Matter/Beta", files: [] },
      ],
    };
    const supported = finding({ id: "SUPPORTED-CONSOLIDATE", problem: "SUPPORTED_CONSOLIDATION_MARKER" });
    const refuted = finding({
      id: "REFUTED-CONSOLIDATE",
      problem: "REFUTED_CONSOLIDATION_MARKER",
      verification: { status: "refuted", reason: "Not supported by the cited source." },
    });

    await consolidate(client, {
      transaction,
      classifiedByEntity: { e1: [], e2: [] },
      findingsByEntity: { e1: [supported, refuted], e2: [] },
      gapsByEntity: { e1: [], e2: [] },
    });

    expect(prompt).toContain("SUPPORTED_CONSOLIDATION_MARKER");
    expect(prompt).not.toContain("REFUTED_CONSOLIDATION_MARKER");
  });

  it("treats duplicate exact filenames as unresolved instead of choosing an arbitrary source", async () => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls++;
          throw new Error("Ambiguous sources must not reach the model.");
        },
      },
    } as unknown as Anthropic;
    const combined =
      sourceBlock("Duplicate.pdf", "FIRST", "/Matter/A/Duplicate.pdf") +
      sourceBlock("Duplicate.pdf", "SECOND", "/Matter/B/Duplicate.pdf");

    const [out] = await verifyFindings(
      client,
      [finding({ id: "AMBIGUOUS", sourceFile: "Duplicate.pdf" })],
      combined,
    );

    expect(calls).toBe(0);
    expect(out.verification?.status).toBe("source_unresolved");
  });

  it("uses exact filename identity and never prefix-matches Akta 12.pdf to Akta 120.pdf", async () => {
    let calls = 0;
    const client = {
      messages: {
        create: async () => {
          calls++;
          throw new Error("A prefix match must not reach the model.");
        },
      },
    } as unknown as Anthropic;

    const [out] = await verifyFindings(
      client,
      [finding({ id: "EXACT", sourceFile: "Akta 12.pdf" })],
      sourceBlock("Akta 120.pdf", "UNRELATED"),
    );

    expect(calls).toBe(0);
    expect(out.verification?.status).toBe("source_unresolved");
  });
});
