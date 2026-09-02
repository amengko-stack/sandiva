import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { verifySystem } from "@/lib/dd/prompts";
import { splitDocBlocks, type DocBlock } from "@/lib/extract-format";
import type { DDFinding, DDVerificationStatus } from "@/types/dd";

// Verification calls stay concurrent, but each call now carries exactly one
// finding and its cited source. A shared batch would let Document B vouch for a
// finding attributed to Document A even if the prompt told the model not to.
const VERIFY_CONCURRENCY = 5;

type Verification = { status: DDVerificationStatus; reason: string };
type Verdict = { id: string; verification: Verification };

const SOURCE_UNRESOLVED: Verification = {
  status: "source_unresolved",
  reason: "Cited source document could not be resolved.",
};
const VERIFICATION_FAILED: Verification = {
  status: "verification_failed",
  reason: "Adversarial verification did not return a usable conclusion.",
};

function citedSource(blocks: DocBlock[], sourceFile: string): DocBlock | null {
  // Exact identity only. Picking the first duplicate would silently turn a
  // filename collision into evidence from an arbitrary SharePoint document.
  const cited = sourceFile.trim();
  const matches = blocks.filter((block) => block.fileName === cited);
  return matches.length === 1 ? matches[0] : null;
}

function conciseReason(value: unknown, fallback: string): string {
  const reason = String(value ?? "").replace(/\s+/g, " ").trim();
  return (reason || fallback).slice(0, 500);
}

// Adversarial pass over source-attributed findings that matter most: every kritis
// finding and every superseded-regulation finding. Deterministic gap findings do
// not cite a document and therefore do not enter a source-document verifier.
//
// Calls run in concurrency-limited waves. A failed call retains its finding with
// an explicit generic failure disposition; raw provider errors stay in logs.
export async function verifyFindings(
  client: Anthropic,
  findings: DDFinding[],
  contextText: string
): Promise<DDFinding[]> {
  // A finding with an existing verifier disposition is not put through it again.
  //
  // Live, a second Stage 5 run reused every aspect and re-derived nothing, yet three
  // findings still disappeared: this step re-ran over the carried findings and the
  // skeptic reached a different verdict that time. So the most serious findings —
  // the only ones verified — were the least stable across runs, and one the lawyer
  // had already read could vanish for no reason but a coin landing differently.
  //
  // Re-verification also cannot see what has changed since: the documents behind a
  // carried finding are byte-identical, which is why the aspect was reused at all.
  // A lawyer who wants the whole examination redone has "force".
  const targets = findings.filter(
    (f) =>
      !f.verified &&
      !f.verification &&
      !!f.sourceFile &&
      (f.severity === "kritis" || f.currencyStatus === "superseded")
  );
  if (targets.length === 0) return findings;

  const blocks = splitDocBlocks(contextText);
  const resolutions = new Map<string, Verification>();
  const resolvable: { finding: DDFinding; source: DocBlock }[] = [];
  for (const finding of targets) {
    const source = citedSource(blocks, finding.sourceFile!);
    if (source) resolvable.push({ finding, source });
    else resolutions.set(finding.id, SOURCE_UNRESOLVED);
  }

  const processFinding = async ({ finding, source }: { finding: DDFinding; source: DocBlock }): Promise<Verdict> => {
    const prompt = `FINDING UNDER REVIEW
${JSON.stringify({
  id: finding.id,
  sourceFile: finding.sourceFile,
  anchor: finding.anchor,
  problem: finding.problem,
  currencyNote: finding.currencyNote ?? null,
})}

AUTHORITATIVE CITED SOURCE
Filename: ${source.fileName}
${source.content}
END AUTHORITATIVE CITED SOURCE

Does the anchor actually appear in this cited source and support the claimed problem?
Return ONLY JSON with one concise conclusion reason, not hidden reasoning:
{"verdicts":[{"id":"${finding.id}","upheld":true|false,"reason":"..."}]}`;
    try {
      const response = await client.messages.create({
        model: MODELS.ddVerify,
        max_tokens: 1500,
        system: verifySystem(),
        messages: [{ role: "user", content: prompt }],
      });
      const raw = response.content.find((b) => b.type === "text")?.text ?? "";
      const match = raw.replace(/```json|```/g, "").match(/\{[\s\S]*\}?/);
      if (!match) throw new Error("Hasil verifikasi bukan JSON");
      let jsonStr = match[0];
      if (response.stop_reason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
      let p: { verdicts?: { id?: string; upheld?: boolean; reason?: unknown }[] };
      try {
        p = JSON.parse(jsonStr);
      } catch {
        p = JSON.parse(repairTruncatedJson(jsonStr));
      }
      const verdict = (p.verdicts ?? []).find(
        (candidate) => String(candidate.id ?? "") === finding.id && typeof candidate.upheld === "boolean"
      );
      if (!verdict) return { id: finding.id, verification: VERIFICATION_FAILED };
      const status = verdict.upheld ? "supported" : "refuted";
      return {
        id: finding.id,
        verification: {
          status,
          reason: conciseReason(
            verdict.reason,
            verdict.upheld
              ? "Finding is supported by the cited source document."
              : "Finding is not supported by the cited source document.",
          ),
        },
      };
    } catch (e) {
      console.error("[dd/verify] finding failed, explicit failure retained:", e instanceof Error ? e.message : e);
      return { id: finding.id, verification: VERIFICATION_FAILED };
    }
  };

  for (let s = 0; s < resolvable.length; s += VERIFY_CONCURRENCY) {
    const wave = resolvable.slice(s, s + VERIFY_CONCURRENCY);
    const settled = await Promise.allSettled(wave.map(processFinding));
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        resolutions.set(result.value.id, result.value.verification);
      } else {
        resolutions.set(wave[i].finding.id, VERIFICATION_FAILED);
      }
    }
  }

  return findings.map((finding) => {
    const verification = resolutions.get(finding.id);
    if (!verification) return finding;
    return {
      ...finding,
      verified: verification.status === "supported",
      verification,
    };
  });
}
