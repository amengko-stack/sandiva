import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import * as analysisState from "@/lib/dd/analysis-state";
import * as redflag from "@/lib/dd/redflag";
import { planChapters, chapterForAspect, isTransactionChapter } from "@/config/ddChapters";
import { redflagSystem } from "@/lib/dd/prompts";
import { resolveRegime } from "@/lib/dd/regime";
import { verifyFindings } from "@/lib/dd/verify";
import type { DDAnalysisState } from "@/lib/dd/analysis-state";
import type { DDAspectId, DDEntity, DDFinding, DDReportOptions } from "@/types/dd";

type StateEntry = {
  docsDigest: string;
  promptDigest: string;
  modelFingerprint?: string;
  analysedAtISO: string;
};

const entity = (name = "PT Alpha"):
  DDEntity => ({
    id: "alpha",
    name,
    role: "target",
    listingStatus: "non_tbk",
    ultimateParentTbk: undefined,
    isBumn: false,
    dataRoomPath: "/alpha",
    files: [],
  });

const PRESENT: DDAspectId[] = ["pendirian_ad", "perizinan"];
const DOCS = "=== akta.pdf ===\n" + "A".repeat(100);
const DOCS_DIGEST = analysisState.seenDigest(DOCS, []);
const SYSTEM_DIGEST = analysisState.promptDigest(redflagSystem(resolveRegime(entity()), "PT Alpha"));
const ANALYSED_AT = "2026-09-02T00:00:00.000Z";

function stored(entry: StateEntry): DDAnalysisState {
  return { aspects: { pendirian_ad: entry, transaksi: entry } } as DDAnalysisState;
}

function reuseAspect(args: {
  prior: DDAnalysisState;
  docsDigest?: string;
  promptDigest?: string;
  modelFingerprint?: string;
  priorFindingCount?: number;
}): boolean {
  return analysisState.canReuseAspect({
    aspectId: "pendirian_ad",
    docsDigest: args.docsDigest ?? DOCS_DIGEST,
    promptDigest: args.promptDigest ?? SYSTEM_DIGEST,
    modelFingerprint: args.modelFingerprint,
    prior: args.prior,
    priorFindingCount: args.priorFindingCount ?? 1,
  } as Parameters<typeof analysisState.canReuseAspect>[0]);
}

function currentModelFingerprint(model = "claude-sonnet-4-6"): string {
  const fn = (analysisState as typeof analysisState & {
    modelFingerprint?: (modelId: string) => string;
  }).modelFingerprint;
  return fn ? fn(model) : model;
}

function aspectSubsections(options: {
  format?: "pendahuluan_led" | "exec_summary_led";
  clientRole?: string;
  transactionImplications?: boolean;
} = {}): string[] {
  const plan = planChapters({
    transactionType: "akuisisi_saham",
    regime: resolveRegime(entity()),
    presentAspects: PRESENT,
    ...options,
  });
  return chapterForAspect(plan, "pendirian_ad")?.subs
    .filter((sub) => !sub.findings)
    .map((sub) => sub.title) ?? [];
}

describe("H-3 analysis cache correctness acceptance fixtures", () => {
  it("Fixture A — reuses unchanged effective aspect input", () => {
    const model = currentModelFingerprint();
    const prior = stored({
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      modelFingerprint: model,
      analysedAtISO: ANALYSED_AT,
    });

    expect(reuseAspect({ prior, modelFingerprint: model })).toBe(true);
  });

  it("Fixture B — reanalyses when effective aspect document text changes", () => {
    const model = currentModelFingerprint();
    const prior = stored({
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      modelFingerprint: model,
      analysedAtISO: ANALYSED_AT,
    });

    expect(reuseAspect({
      prior,
      docsDigest: analysisState.seenDigest(DOCS + " changed", []),
      modelFingerprint: model,
    })).toBe(false);
  });

  it("Fixture C — reanalyses when material instructions change", () => {
    const model = currentModelFingerprint();
    const prior = stored({
      docsDigest: DOCS_DIGEST,
      promptDigest: analysisState.promptDigest("instructions-v1"),
      modelFingerprint: model,
      analysedAtISO: ANALYSED_AT,
    });

    expect(reuseAspect({
      prior,
      promptDigest: analysisState.promptDigest("instructions-v2"),
      modelFingerprint: model,
    })).toBe(false);
  });

  it("Fixture D — transaction context changing the aspect prompt reanalyses", () => {
    const model = currentModelFingerprint();
    const identityBuilder = (redflag as typeof redflag & {
      aspectModelInput?: (args: Record<string, unknown>) => {
        system: string; promptFingerprintText: string; requestConfigFingerprintText: string;
      };
    }).aspectModelInput;
    const reuseIdentity = (analysisState as typeof analysisState & {
      reuseIdentity?: (args: {
        docsDigest: string; systemPrompt: string; promptFingerprintText: string; modelId: string;
        requestConfigFingerprintText: string;
      }) => { docsDigest: string; promptDigest: string; modelFingerprint: string };
    }).reuseIdentity;

    expect(typeof identityBuilder).toBe("function");
    expect(typeof reuseIdentity).toBe("function");
    if (!identityBuilder || !reuseIdentity) return;

    const common = {
      entityId: "alpha",
      entityName: "PT Alpha",
      aspectId: "pendirian_ad",
      docsText: DOCS,
      regime: resolveRegime(entity()),
      subsections: aspectSubsections(),
      omittedDocs: [],
      unreadableDocs: [],
      failedDocs: [],
    };
    const beforeInput = identityBuilder({ ...common, transactionType: "akuisisi_saham" });
    const afterInput = identityBuilder({ ...common, transactionType: "merger" });
    const before = reuseIdentity({
      docsDigest: DOCS_DIGEST,
      systemPrompt: beforeInput.system,
      promptFingerprintText: beforeInput.promptFingerprintText,
      requestConfigFingerprintText: beforeInput.requestConfigFingerprintText,
      modelId: "claude-sonnet-4-6",
    });
    const after = reuseIdentity({
      docsDigest: DOCS_DIGEST,
      systemPrompt: afterInput.system,
      promptFingerprintText: afterInput.promptFingerprintText,
      requestConfigFingerprintText: afterInput.requestConfigFingerprintText,
      modelId: "claude-sonnet-4-6",
    });
    const prior = stored({ ...before, analysedAtISO: ANALYSED_AT });

    expect(reuseAspect({ prior, ...after })).toBe(false);
  });

  it("Fixture E — reanalyses when the configured model identifier changes", () => {
    const before = currentModelFingerprint("claude-sonnet-4-6");
    const after = currentModelFingerprint("claude-sonnet-next");
    const prior = stored({
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      modelFingerprint: before,
      analysedAtISO: ANALYSED_AT,
    });

    expect(reuseAspect({ prior, modelFingerprint: after })).toBe(false);
  });

  it("Fixture F — ignores transaction corpus changes outside actual model input", () => {
    const effectiveDocs = (redflag as typeof redflag & {
      transactionEffectiveDocsText?: (docsText: string) => string;
    }).transactionEffectiveDocsText;
    const digest = (analysisState as typeof analysisState & {
      transactionSeenDigest: (docsText: string, unreadable: string[], failed: string[]) => string;
    }).transactionSeenDigest;

    expect(typeof effectiveDocs).toBe("function");
    if (!effectiveDocs) return;
    const prefix = "A".repeat(220_000);
    const common = {
      entityId: "alpha",
      entityName: "PT Alpha",
      unreadableDocs: [],
      failedDocs: [],
      transactionType: "akuisisi_saham" as const,
      regime: resolveRegime(entity()),
      subsections: ["Persetujuan Transaksi"],
    };
    const beforeInput = redflag.transactionModelInput({ ...common, docsText: prefix + "tail one" });
    const afterInput = redflag.transactionModelInput({ ...common, docsText: prefix + "tail two" });

    expect(afterInput.prompt).toBe(beforeInput.prompt);
    expect(digest(effectiveDocs(prefix + "tail one"), [], [])).toBe(
      digest(effectiveDocs(prefix + "tail two"), [], [])
    );
  });

  it("Fixture G — reanalyses when supplied transaction-analysis text changes", () => {
    const effectiveDocs = (redflag as typeof redflag & {
      transactionEffectiveDocsText?: (docsText: string) => string;
    }).transactionEffectiveDocsText;
    const digest = (analysisState as typeof analysisState & {
      transactionSeenDigest: (docsText: string, unreadable: string[], failed: string[]) => string;
    }).transactionSeenDigest;

    expect(typeof effectiveDocs).toBe("function");
    if (!effectiveDocs) return;
    const common = {
      entityId: "alpha",
      entityName: "PT Alpha",
      unreadableDocs: [],
      failedDocs: [],
      transactionType: "akuisisi_saham" as const,
      regime: resolveRegime(entity()),
      subsections: ["Persetujuan Transaksi"],
    };
    expect(redflag.transactionModelInput({ ...common, docsText: "effective A" }).prompt).not.toBe(
      redflag.transactionModelInput({ ...common, docsText: "effective B" }).prompt
    );
    expect(digest(effectiveDocs("effective A"), [], [])).not.toBe(
      digest(effectiveDocs("effective B"), [], [])
    );
  });

  it("Fixture H — rejects legacy state missing H-3 fingerprints", () => {
    const legacy = stored({
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      analysedAtISO: ANALYSED_AT,
    });

    expect(reuseAspect({ prior: legacy, modelFingerprint: currentModelFingerprint() })).toBe(false);

    const identity = {
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      modelFingerprint: currentModelFingerprint(),
    };
    const regenerated = stored(analysisState.analysisStateEntry(identity, ANALYSED_AT));
    expect(regenerated.aspects.pendirian_ad).toEqual({ ...identity, analysedAtISO: ANALYSED_AT });
    expect(reuseAspect({ prior: regenerated, modelFingerprint: currentModelFingerprint() })).toBe(true);
  });

  it("Fixture I — a bilingual-heading export change preserves reuse", () => {
    const beforeOptions: DDReportOptions = {
      legalConsequenceColumn: true,
      bilingualHeadings: false,
      includeTimPemeriksa: false,
      transactionImplications: false,
    };
    const afterOptions = { ...beforeOptions, bilingualHeadings: true };
    const beforeSubs = aspectSubsections({ transactionImplications: beforeOptions.transactionImplications });
    const afterSubs = aspectSubsections({ transactionImplications: afterOptions.transactionImplications });
    const model = currentModelFingerprint();
    const prior = stored({
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      modelFingerprint: model,
      analysedAtISO: ANALYSED_AT,
    });

    expect(afterSubs).toEqual(beforeSubs);
    expect(reuseAspect({ prior, modelFingerprint: model })).toBe(true);
  });

  it("Fixture J — legitimate reuse preserves review, grounding, and H-1 disposition", async () => {
    const model = currentModelFingerprint();
    const priorState = stored({
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      modelFingerprint: model,
      analysedAtISO: ANALYSED_AT,
    });
    const finding: DDFinding = {
      id: "stable-id",
      entityId: "alpha",
      aspectId: "pendirian_ad",
      dimension: "risiko",
      severity: "kritis",
      anchor: "kutipan",
      sourceFile: "akta.pdf",
      problem: "masalah",
      whyItMatters: "dampak",
      suggestedFix: "perbaikan",
      verified: true,
      status: "edited",
      editedProblem: "redaksi partner dipertahankan",
      grounding: { verdict: "verified", coverage: 1, note: "exact" },
      verification: { status: "supported", reason: "supported by cited source" },
    };
    let verifierCalls = 0;
    const client = {
      messages: { create: async () => { verifierCalls++; throw new Error("must not run"); } },
    } as unknown as Anthropic;

    expect(reuseAspect({ prior: priorState, modelFingerprint: model })).toBe(true);
    const out = await verifyFindings(client, [finding], DOCS);
    expect(out).toBeInstanceOf(Array);
    expect(out[0]).toBe(finding);
    expect(out[0]).toEqual(finding);
    expect(verifierCalls).toBe(0);
  });

  it("transaction reuse requires the same complete H-3 identity", () => {
    const canReuseTransaction = (analysisState as typeof analysisState & {
      canReuseTransaction?: (args: Record<string, unknown>) => boolean;
    }).canReuseTransaction;
    expect(typeof canReuseTransaction).toBe("function");
    if (!canReuseTransaction) return;

    const model = currentModelFingerprint();
    const prior = stored({
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      modelFingerprint: model,
      analysedAtISO: ANALYSED_AT,
    });
    expect(canReuseTransaction({
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      modelFingerprint: model,
      prior,
      priorCovers: true,
    })).toBe(true);
    expect(canReuseTransaction({
      docsDigest: DOCS_DIGEST,
      promptDigest: SYSTEM_DIGEST,
      modelFingerprint: currentModelFingerprint("other-model"),
      prior,
      priorCovers: true,
    })).toBe(false);
  });

  it("transaction prompt identity follows the actual chapter groups", () => {
    const inputBuilder = (redflag as typeof redflag & {
      transactionModelInput?: (args: Record<string, unknown>) => {
        system: string; promptFingerprintText: string;
      };
    }).transactionModelInput;
    expect(typeof inputBuilder).toBe("function");
    if (!inputBuilder) return;

    const plan = planChapters({
      transactionType: "akuisisi_saham",
      regime: resolveRegime(entity()),
      presentAspects: PRESENT,
      clientRole: "pembeli",
    });
    const groups = plan
      .filter(isTransactionChapter)
      .map((chapter) => chapter.subs.map((sub) => sub.title));
    const inputs = groups.map((subsections) => inputBuilder({
      entityId: "alpha",
      entityName: "PT Alpha",
      docsText: DOCS,
      unreadableDocs: [],
      failedDocs: [],
      transactionType: "akuisisi_saham",
      regime: resolveRegime(entity()),
      subsections,
    }));

    expect(inputs).toHaveLength(groups.length);
    expect(inputs.every((input) => input.promptFingerprintText.includes("SUB-BAGIAN"))).toBe(true);
  });

  it("entity and regime framing change the aspect prompt identity", () => {
    const common = {
      entityId: "alpha",
      aspectId: "pendirian_ad" as const,
      docsText: DOCS,
      transactionType: "akuisisi_saham" as const,
      subsections: aspectSubsections(),
      omittedDocs: [],
      unreadableDocs: [],
      failedDocs: [],
    };
    const privateInput = redflag.aspectModelInput({
      ...common,
      entityName: "PT Alpha",
      regime: resolveRegime(entity("PT Alpha")),
    });
    const listed = { ...entity("PT Alpha Tbk"), listingStatus: "tbk" as const };
    const listedInput = redflag.aspectModelInput({
      ...common,
      entityName: listed.name,
      regime: resolveRegime(listed),
    });

    const privateIdentity = analysisState.reuseIdentity({
      docsDigest: DOCS_DIGEST,
      systemPrompt: privateInput.system,
      promptFingerprintText: privateInput.promptFingerprintText,
      requestConfigFingerprintText: privateInput.requestConfigFingerprintText,
      modelId: privateInput.model,
    });
    const listedIdentity = analysisState.reuseIdentity({
      docsDigest: DOCS_DIGEST,
      systemPrompt: listedInput.system,
      promptFingerprintText: listedInput.promptFingerprintText,
      requestConfigFingerprintText: listedInput.requestConfigFingerprintText,
      modelId: listedInput.model,
    });
    expect(listedIdentity.promptDigest).not.toBe(privateIdentity.promptDigest);
  });

  it("report format and transaction implications invalidate only through changed model subsections", () => {
    const defaultSubs = aspectSubsections({ format: "pendahuluan_led", transactionImplications: false });
    const summarySubs = aspectSubsections({ format: "exec_summary_led", transactionImplications: false });
    const implicationsSubs = aspectSubsections({ format: "exec_summary_led", transactionImplications: true });

    expect(summarySubs).not.toEqual(defaultSubs);
    expect(implicationsSubs).not.toEqual(summarySubs);
  });

  it("client role changes transaction prompt groups when the planned transaction chapters change", () => {
    const groupsFor = (clientRole: string) => planChapters({
      transactionType: "akuisisi_saham",
      regime: resolveRegime(entity()),
      presentAspects: PRESENT,
      clientRole,
    }).filter(isTransactionChapter).map((chapter) => chapter.subs.map((sub) => sub.title));

    expect(groupsFor("penjual")).not.toEqual(groupsFor("pembeli"));
  });

  it("material model request configuration changes the prompt fingerprint", () => {
    const build = analysisState.reuseIdentity as (args: {
      docsDigest: string;
      systemPrompt: string;
      promptFingerprintText: string;
      requestConfigFingerprintText: string;
      modelId: string;
    }) => analysisState.DDReuseIdentity;
    const common = {
      docsDigest: DOCS_DIGEST,
      systemPrompt: "system",
      promptFingerprintText: "prompt",
      modelId: "claude-sonnet-4-6",
    };

    const before = build({ ...common, requestConfigFingerprintText: '{"max_tokens":8000}' });
    const after = build({ ...common, requestConfigFingerprintText: '{"max_tokens":9000}' });
    expect(after.promptDigest).not.toBe(before.promptDigest);
  });
});
