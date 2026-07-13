import { queryPerplexity } from "@/lib/dd/perplexity";
import { repairTruncatedJson } from "@/lib/json-repair";
import type { DDCurrencyStatus, DDFinding } from "@/types/dd";

export interface CurrencyVerdict { status: DDCurrencyStatus; note: string; }

export function collectRegulationRefs(findings: DDFinding[]): string[] {
  return [...new Set(findings.flatMap((f) => f.regulationRefs ?? []))].sort();
}

const UNKNOWN: CurrencyVerdict = {
  status: "unknown",
  note: "Pemeriksaan keberlakuan tidak tersedia — verifikasi manual sebelum diandalkan.",
};

// ONE web-grounded call for the whole ref list. SOFT-FAIL: any error →
// every ref "unknown"; a currency outage must never block a review.
export async function checkCurrency(
  refs: string[],
  fetchImpl?: typeof fetch
): Promise<Record<string, CurrencyVerdict>> {
  if (refs.length === 0) return {};
  try {
    const prompt = `Untuk setiap peraturan Indonesia berikut, apakah masih berlaku per hari ini, sudah diubah, atau sudah dicabut/diganti? Perhatikan UU Cipta Kerja dan peraturan turunannya.
${refs.map((r) => `- ${r}`).join("\n")}

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
    const map: Record<string, CurrencyVerdict> = {};
    for (const ref of refs) map[ref] = UNKNOWN;
    for (const r of parsed.results ?? []) {
      if (!r.ref || !(r.ref in map)) continue;
      const status = r.status === "current" || r.status === "superseded" ? r.status : "unknown";
      map[r.ref] = { status, note: String(r.note ?? "") };
    }
    return map;
  } catch (e) {
    console.error("[dd/currency] soft-fail:", e instanceof Error ? e.message : e);
    return Object.fromEntries(refs.map((r) => [r, UNKNOWN]));
  }
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
