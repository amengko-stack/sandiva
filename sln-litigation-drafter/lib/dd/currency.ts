import { queryPerplexity } from "@/lib/dd/perplexity";
import { repairTruncatedJson } from "@/lib/json-repair";
import type { DDCurrencyStatus, DDFinding } from "@/types/dd";

export interface CurrencyVerdict { status: DDCurrencyStatus; note: string; }

export function collectRegulationRefs(findings: DDFinding[]): string[] {
  return Array.from(new Set(findings.flatMap((f) => f.regulationRefs ?? []))).sort();
}

const UNKNOWN: CurrencyVerdict = {
  status: "unknown",
  note: "Pemeriksaan keberlakuan tidak tersedia — verifikasi manual sebelum diandalkan.",
};

// Refs are checked in SMALL BATCHES, not one big list. Measured against a real
// 46-ref data room: a single call for all 46 returned a real verdict for only
// 1 of them (sonar hedges to "unknown" when asked to research too many at once),
// while batches of 10 run concurrently returned 42/46 — 24 of them superseded —
// in the same wall-clock time. Batching is what makes this feature work at all.
const REF_BATCH = 10;
const CURRENCY_CONCURRENCY = 5;

// SOFT-FAIL per batch: a failing batch leaves only its own refs "unknown";
// a currency outage must never block a review.
export async function checkCurrency(
  refs: string[],
  fetchImpl?: typeof fetch
): Promise<Record<string, CurrencyVerdict>> {
  if (refs.length === 0) return {};

  const map: Record<string, CurrencyVerdict> = {};
  for (const ref of refs) map[ref] = UNKNOWN;

  const batches: string[][] = [];
  for (let i = 0; i < refs.length; i += REF_BATCH) batches.push(refs.slice(i, i + REF_BATCH));

  const askBatch = async (batch: string[]): Promise<[string, CurrencyVerdict][]> => {
    try {
      const prompt = `Untuk setiap peraturan Indonesia berikut, apakah masih berlaku per hari ini, sudah diubah, atau sudah dicabut/diganti? Perhatikan UU Cipta Kerja dan peraturan turunannya.
${batch.map((r) => `- ${r}`).join("\n")}

Jawab HANYA JSON: {"results":[{"ref":"<persis seperti daftar>","status":"current|superseded|unknown","note":"penjelasan singkat + peraturan pengganti bila ada"}]}`;
      const raw = await queryPerplexity(prompt, undefined, fetchImpl);
      const match = raw.replace(/```json|```/g, "").match(/\{[\s\S]*\}?/);
      if (!match) throw new Error("bukan JSON");
      let parsed: { results?: { ref?: string; status?: string; note?: string }[] };
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = JSON.parse(repairTruncatedJson(match[0]));
      }
      const out: [string, CurrencyVerdict][] = [];
      const inBatch = new Set(batch);
      for (const r of parsed.results ?? []) {
        if (!r.ref || !inBatch.has(r.ref)) continue;
        const status = r.status === "current" || r.status === "superseded" ? r.status : "unknown";
        out.push([r.ref, { status, note: String(r.note ?? "") }]);
      }
      return out;
    } catch (e) {
      console.error("[dd/currency] batch soft-fail:", e instanceof Error ? e.message : e);
      return [];
    }
  };

  for (let s = 0; s < batches.length; s += CURRENCY_CONCURRENCY) {
    const wave = batches.slice(s, s + CURRENCY_CONCURRENCY);
    const settled = await Promise.allSettled(wave.map(askBatch));
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      for (const [ref, verdict] of r.value) map[ref] = verdict;
    }
  }

  return map;
}

export function applyCurrency(
  findings: DDFinding[],
  map: Record<string, CurrencyVerdict>
): DDFinding[] {
  return findings.map((f) => {
    const refs = f.regulationRefs ?? [];
    if (refs.length === 0) return f;
    const verdicts = refs.map((r) => map[r]).filter(Boolean);
    if (verdicts.length === 0) return f;
    const superseded = verdicts.find((v) => v.status === "superseded");
    if (superseded) {
      return {
        ...f,
        currencyStatus: "superseded",
        currencyNote: superseded.note,
        severity: f.severity === "minor" ? "material" : f.severity,
      };
    }
    const allCurrent = verdicts.every((v) => v.status === "current");
    return { ...f, currencyStatus: allCurrent ? "current" : "unknown", currencyNote: verdicts.map((v) => v.note).filter(Boolean).join(" ") };
  });
}
