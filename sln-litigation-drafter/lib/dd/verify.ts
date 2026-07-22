import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { verifySystem } from "@/lib/dd/prompts";
import type { DDFinding } from "@/types/dd";

const CONTEXT_CAP = 50_000;
const BATCH = 10;
const VERIFY_CONCURRENCY = 3;

type Verdict = { id: string; upheld: boolean };

// Adversarial pass over the findings that matter most: every kritis finding and
// every superseded-regulation finding. Refuted → dropped; survivors → verified.
//
// Batches run concurrently (VERIFY_CONCURRENCY waves): each batch is an
// independent model call against the same read-only context, so there is no
// shared-state race — verdicts are merged into `keep` sequentially after each
// wave settles. A batch that fails (non-JSON, unparseable, API error) SOFT-FAILS
// to no verdicts rather than throwing: its findings then pass through UNVERIFIED
// (never dropped). Verify only ever *removes* refuted findings, so an inability
// to verify must keep the finding, not silently delete it — and one bad batch
// must not abort the whole Stage-5 analysis.
export async function verifyFindings(
  client: Anthropic,
  findings: DDFinding[],
  contextText: string
): Promise<DDFinding[]> {
  const targets = findings.filter((f) => f.severity === "kritis" || f.currencyStatus === "superseded");
  if (targets.length === 0) return findings;

  const context = contextText.slice(0, CONTEXT_CAP);

  const batches: DDFinding[][] = [];
  for (let i = 0; i < targets.length; i += BATCH) {
    batches.push(targets.slice(i, i + BATCH));
  }

  const processBatch = async (batch: DDFinding[]): Promise<Verdict[]> => {
    const prompt = `=== KONTEKS DOKUMEN ===
${context}
=== AKHIR KONTEKS ===

TEMUAN YANG DIPERIKSA:
${batch.map((f) => JSON.stringify({ id: f.id, anchor: f.anchor, problem: f.problem, currencyNote: f.currencyNote ?? null })).join("\n")}

Untuk SETIAP temuan: apakah kutipan (anchor) benar-benar ada dan mendukung masalah yang diklaim? Temuan gap (anchor kosong) dinilai dari konteks.
Kembalikan HANYA JSON: {"verdicts":[{"id":"...","upheld":true|false,"reason":"..."}]}`;
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
      let p: { verdicts?: { id?: string; upheld?: boolean }[] };
      try {
        p = JSON.parse(jsonStr);
      } catch {
        p = JSON.parse(repairTruncatedJson(jsonStr));
      }
      const verdicts: Verdict[] = [];
      for (const v of p.verdicts ?? []) {
        if (v.id) verdicts.push({ id: String(v.id), upheld: v.upheld === true });
      }
      return verdicts;
    } catch (e) {
      // Soft-fail: this batch's findings will pass through unverified rather
      // than aborting the whole analysis run.
      console.error("[dd/verify] batch failed, findings pass through unverified:", e instanceof Error ? e.message : e);
      return [];
    }
  };

  const keep = new Map<string, boolean>();
  for (let s = 0; s < batches.length; s += VERIFY_CONCURRENCY) {
    const wave = batches.slice(s, s + VERIFY_CONCURRENCY);
    const settled = await Promise.allSettled(wave.map(processBatch));
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      for (const v of r.value) keep.set(v.id, v.upheld);
    }
  }

  return findings.flatMap((f) => {
    if (!keep.has(f.id)) return [f];           // not a verify target, or unverified batch → pass through
    return keep.get(f.id) ? [{ ...f, verified: true }] : []; // refuted → dropped
  });
}
