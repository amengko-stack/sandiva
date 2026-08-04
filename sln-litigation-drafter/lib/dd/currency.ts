import { queryPerplexity } from "@/lib/dd/perplexity";
import { currencyGroupKey } from "@/lib/dd/reg-refs";
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

  // Group refs that denote the same provision (differing only by ayat/huruf, or
  // by alias vs numeric form) so each provision is asked ONCE and every spelling
  // of it receives the same verdict. Without this, one report could show the
  // same article as both superseded and amended.
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    const key = currencyGroupKey(ref);
    const existing = groups.get(key);
    if (existing) existing.push(ref);
    else groups.set(key, [ref]);
  }
  const queryKeys = Array.from(groups.keys());

  const batches: string[][] = [];
  for (let i = 0; i < queryKeys.length; i += REF_BATCH) {
    batches.push(queryKeys.slice(i, i + REF_BATCH));
  }

  // Batch elements are already fully-qualified query strings (number + year +
  // title); a bare number gets "nomor ini perlu verifikasi judulnya" back.
  const askBatch = async (batch: string[]): Promise<[string, CurrencyVerdict][]> => {
    try {
      const prompt = `Untuk setiap ketentuan hukum Indonesia berikut, tentukan status KETENTUAN YANG DIKUTIP ITU SENDIRI — bukan status undang-undang induknya secara umum.

Gunakan salah satu status berikut.
status "current" = ketentuan yang dikutip masih berlaku dan rumusannya tidak diubah.
status "amended" = ketentuan yang dikutip MASIH BERLAKU tetapi rumusannya telah diubah (mis. oleh UU Cipta Kerja); sebutkan peraturan pengubahnya.
status "superseded" = ketentuan yang dikutip telah DICABUT atau DIGANTI sehingga tidak lagi berlaku.
status "unknown" = tidak dapat dipastikan dari sumber yang tersedia.

PENTING: fakta bahwa undang-undang induknya pernah diubah pada bagian LAIN tidak membuat ketentuan yang dikutip menjadi "amended" atau "superseded". Nilai hanya ketentuan yang dikutip. Bila hanya penomoran pasalnya bergeser, sebut "amended", bukan "superseded".

Daftar ketentuan yang dinilai (setiap baris diawali tanda hubung):
${batch.map((r) => `- ${r}`).join("\n")}

Jawab HANYA JSON: {"results":[{"ref":"<persis seperti daftar>","status":"current|amended|superseded|unknown","note":"penjelasan singkat + peraturan pengubah/pengganti bila ada"}]}`;
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
        if (!r.ref) continue;
        // The model usually echoes the expanded string it was given, but it may
        // shorten it. Fall back to re-deriving the group key so a correct verdict
        // is never discarded merely because the echo was abbreviated.
        const groupKey = inBatch.has(r.ref)
          ? r.ref
          : inBatch.has(currencyGroupKey(r.ref))
            ? currencyGroupKey(r.ref)
            : null;
        if (!groupKey) continue;
        const status: DDCurrencyStatus =
          r.status === "current" || r.status === "amended" || r.status === "superseded"
            ? r.status
            : "unknown";
        out.push([groupKey, { status, note: String(r.note ?? "") }]);
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
      // Verdicts come back keyed by group; apply each to every ref in that group
      // so all spellings of one provision agree.
      for (const [groupKey, verdict] of r.value) {
        for (const original of groups.get(groupKey) ?? []) map[original] = verdict;
      }
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
    // Only genuine supersession escalates severity. Escalating on "amended"
    // would re-introduce the defect this split exists to fix: an in-force
    // provision whose wording changed is not a reason to upgrade a finding.
    const superseded = verdicts.find((v) => v.status === "superseded");
    if (superseded) {
      return {
        ...f,
        currencyStatus: "superseded",
        currencyNote: superseded.note,
        severity: f.severity === "minor" ? "material" : f.severity,
      };
    }
    const amended = verdicts.find((v) => v.status === "amended");
    if (amended) {
      return { ...f, currencyStatus: "amended", currencyNote: amended.note };
    }
    const allCurrent = verdicts.every((v) => v.status === "current");
    return { ...f, currencyStatus: allCurrent ? "current" : "unknown", currencyNote: verdicts.map((v) => v.note).filter(Boolean).join(" ") };
  });
}
