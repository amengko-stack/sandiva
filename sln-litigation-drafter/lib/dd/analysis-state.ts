import { createHash } from "crypto";
import type { DDAspectId, DDClassifiedDoc } from "@/types/dd";

/**
 * Which aspects were analysed, and against which documents.
 *
 * This exists because of a measurement, not a hunch. Two consecutive Stage 5 runs
 * over an unchanged data room kept only 7 of 33 model findings under a stable
 * identity — 21%. The model re-quotes a different passage and rewords the problem,
 * so any identity derived from its output moves. That broke two things at once: the
 * supplement reported 33 findings as "no longer raised" when the issues had not
 * gone anywhere, and the lawyer's dismissals and rewordings were lost on four
 * findings in five.
 *
 * The alternatives measured worse or were unsafe. Keying on aspect and file alone
 * matched 76% but collided 15 times within a single run, so review state would land
 * on the wrong issue. A similarity matcher reached 52% recall at a threshold whose
 * precision is unknown — and in a legal deliverable a dismissal attached to the
 * wrong finding is far worse than a dismissal lost.
 *
 * So the fix is not to match findings better. It is to stop regenerating findings
 * that nothing has changed for: an aspect whose documents are byte-identical to the
 * last run keeps its findings untouched, ids and all. Identity stops mattering
 * because nothing is re-derived.
 */

export interface DDAnalysisState {
  /**
   * Digest of the documents fed to each aspect, the instructions it was given, and
   * when it was last analysed.
   *
   * promptDigest is here because of a near miss. Five misstatements of UUPT were
   * found by reading a live report and corrected in the prompt — and the corrections
   * would never have reached that report, or any existing matter. Reuse turned only
   * on the documents, which had not changed, so every session would have gone on
   * serving the analysis written under the old instructions, indefinitely and
   * silently. An improvement nobody receives is indistinguishable from no
   * improvement.
   *
   * Optional so a state written before this field simply re-analyses once, which is
   * the safe direction.
   */
  aspects: Record<string, {
    docsDigest: string;
    promptDigest?: string;
    /** Optional only so pre-H-3 state parses and then fails the reuse check safely. */
    modelFingerprint?: string;
    analysedAtISO: string;
  }>;
}

export interface DDReuseIdentity {
  docsDigest: string;
  promptDigest: string;
  modelFingerprint: string;
}

export function analysisStateEntry(identity: DDReuseIdentity, analysedAtISO: string) {
  return {
    docsDigest: identity.docsDigest,
    promptDigest: identity.promptDigest,
    modelFingerprint: identity.modelFingerprint,
    analysedAtISO,
  };
}

/**
 * Deterministic digest primitive for the instructions an analysis was produced under.
 *
 * H-3 passes the constructed system text, document-redacted user-prompt text and
 * material request configuration through this primitive. A hand-maintained version
 * number would be forgotten exactly when it mattered most: the run after a fix.
 */
export function promptDigest(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
}

/** Configured model identity, kept separate so a model-only cache miss is auditable. */
export function modelFingerprint(modelId: string): string {
  return createHash("sha256").update(modelId).digest("hex").slice(0, 16);
}

/**
 * Identity for one reusable analysis stage.
 *
 * The prompt material is produced by the same deterministic builders as the live
 * model request, with document values represented by stable markers. Documents are
 * therefore hashed exactly once by docsDigest while every material instruction and
 * transaction-context or request-configuration change still invalidates promptDigest.
 */
export function reuseIdentity(args: {
  docsDigest: string;
  systemPrompt: string;
  promptFingerprintText: string;
  requestConfigFingerprintText: string;
  modelId: string;
}): DDReuseIdentity {
  return {
    docsDigest: args.docsDigest,
    promptDigest: promptDigest(JSON.stringify([
      args.systemPrompt,
      args.promptFingerprintText,
      args.requestConfigFingerprintText,
    ])),
    modelFingerprint: modelFingerprint(args.modelId),
  };
}

export const EMPTY_ANALYSIS_STATE: DDAnalysisState = { aspects: {} };

export function parseAnalysisState(raw: string | null): DDAnalysisState {
  if (!raw) return EMPTY_ANALYSIS_STATE;
  try {
    const parsed = JSON.parse(raw) as DDAnalysisState;
    return parsed && typeof parsed === "object" && parsed.aspects ? parsed : EMPTY_ANALYSIS_STATE;
  } catch {
    // A corrupt state file must mean "analyse everything", never "skip everything".
    return EMPTY_ANALYSIS_STATE;
  }
}

/**
 * Digest of exactly what an aspect will be shown.
 *
 * Both the file names and their extracted text, because either changing changes the
 * analysis: a replaced document keeps its name, and a re-OCR changes the text under
 * an unchanged name. Sorted so file ordering cannot produce a spurious difference.
 */
/**
 * Digest of exactly what the model was shown, and of what it was told it could not
 * see.
 *
 * aspectDocsDigest below hashes the whole corpus for an aspect. That is the right
 * answer to "did the documents change", and the wrong answer to "would this run
 * produce the same analysis" — which is what reuse actually turns on. Selection
 * sits between the two: when whole-document packing replaced a mid-stream cut, the
 * corpus was identical, so every existing matter would have kept serving analysis
 * written from a truncated view of its own data room. Hashing the selected text
 * closes that, and closes it for any future change to the cap or the packing rule
 * without anyone having to remember.
 */
/**
 * Everything about the documents that reaches the model, including what it is told
 * it cannot see.
 *
 * `unreadable` and `failed` are part of the key for the same reason `omitted` is:
 * they appear in the user prompt, so an analysis produced without them was produced
 * under different instructions. Leaving either out would make the cache describe
 * only part of the request and silently preserve an outdated analysis.
 */
export function seenDigest(
  docsText: string,
  omitted: string[],
  unreadable: string[] = [],
  failed: string[] = []
): string {
  // Preserve the exact pre-H-2 digest whenever there are no failed documents, so
  // OCR-only and fully-readable matters do not re-analyse merely because this
  // optional context was added.
  const priorMaterial = `${docsText}\u0000${omitted.join("|")}\u0000${unreadable.join("|")}`;
  const material = failed.length > 0 ? `${priorMaterial}\u0000${failed.join("|")}` : priorMaterial;
  return createHash("sha256")
    .update(material)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Digest of the effective readable corpus and supplied-but-unreadable context
 * shown to the transaction-chapter analyzer. The caller must pass the capped
 * text returned by transactionEffectiveDocsText, never the larger source corpus.
 * Chapter/subsection context belongs to the separately auditable prompt digest.
 */
export function transactionSeenDigest(
  docsText: string,
  unreadable: string[],
  failed: string[]
): string {
  return seenDigest(docsText, [], unreadable, failed);
}

export function aspectDocsDigest(
  aspectId: DDAspectId,
  classified: DDClassifiedDoc[],
  contentByFile: Map<string, string>
): string {
  const parts = classified
    .filter((c) => c.aspectId === aspectId)
    .map((c) => c.fileName)
    .sort()
    .map((name) => `${name}${contentByFile.get(name) ?? ""}`);
  return createHash("sha256").update(parts.join("")).digest("hex").slice(0, 32);
}

/**
 * May this aspect's previous findings be reused as they are?
 *
 * Requires all three: the same documents, a record that the aspect was actually
 * analysed before, and findings surviving from that run. Missing any of them, the
 * aspect is analysed — the failure mode to avoid is skipping an aspect that has
 * nothing to carry, which would silently drop it from the report.
 */
export function canReuseAspect(args: {
  aspectId: DDAspectId;
  docsDigest: string;
  /** Digest of the instructions this run would use. */
  promptDigest: string;
  /** Fingerprint of the configured model this run would use. */
  modelFingerprint: string;
  prior: DDAnalysisState;
  priorFindingCount: number;
}): boolean {
  const rec = args.prior.aspects[args.aspectId];
  if (rec === undefined) return false;
  if (rec.docsDigest !== args.docsDigest) return false;
  // Instructions changed since this was analysed, so the answer would differ. A
  // record written before promptDigest existed re-analyses once, which is safe.
  if (rec.promptDigest !== args.promptDigest) return false;
  // Missing means the record predates H-3. It re-analyses once rather than silently
  // interpreting today's configured model as the model that produced old output.
  if (!args.modelFingerprint || rec.modelFingerprint !== args.modelFingerprint) return false;
  return args.priorFindingCount > 0;
}

/** Transaction chapters use the same semantic identity but do not require findings. */
export function canReuseTransaction(args: DDReuseIdentity & {
  prior: DDAnalysisState;
  priorCovers: boolean;
}): boolean {
  const rec = args.prior.aspects.transaksi;
  if (!rec || !args.priorCovers) return false;
  return rec.docsDigest === args.docsDigest &&
    rec.promptDigest === args.promptDigest &&
    rec.modelFingerprint === args.modelFingerprint;
}
