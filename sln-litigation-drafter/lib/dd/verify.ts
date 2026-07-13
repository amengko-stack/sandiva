import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { verifySystem } from "@/lib/dd/prompts";
import type { DDFinding } from "@/types/dd";

const CONTEXT_CAP = 50_000;
const BATCH = 10;

// Adversarial pass over the findings that matter most: every kritis finding and
// every superseded-regulation finding. Refuted → dropped; survivors → verified.
export async function verifyFindings(
  client: Anthropic,
  findings: DDFinding[],
  contextText: string
): Promise<DDFinding[]> {
  const targets = findings.filter((f) => f.severity === "kritis" || f.currencyStatus === "superseded");
  if (targets.length === 0) return findings;

  const keep = new Map<string, boolean>();
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const prompt = `=== KONTEKS DOKUMEN ===
${contextText.slice(0, CONTEXT_CAP)}
=== AKHIR KONTEKS ===

TEMUAN YANG DIPERIKSA:
${batch.map((f) => JSON.stringify({ id: f.id, anchor: f.anchor, problem: f.problem, currencyNote: f.currencyNote ?? null })).join("\n")}

Untuk SETIAP temuan: apakah kutipan (anchor) benar-benar ada dan mendukung masalah yang diklaim? Temuan gap (anchor kosong) dinilai dari konteks.
Kembalikan HANYA JSON: {"verdicts":[{"id":"...","upheld":true|false,"reason":"..."}]}`;
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
    for (const v of p.verdicts ?? []) {
      if (v.id) keep.set(String(v.id), v.upheld === true);
    }

    const missing = batch.filter((f) => !keep.has(f.id)).map((f) => f.id);
    if (missing.length) {
      throw new Error(`Hasil verifikasi tidak lengkap — tidak ada putusan untuk temuan: ${missing.join(", ")}`);
    }
  }

  return findings.flatMap((f) => {
    if (!keep.has(f.id)) return [f];           // not a verify target → pass through
    return keep.get(f.id) ? [{ ...f, verified: true }] : []; // refuted → dropped
  });
}
