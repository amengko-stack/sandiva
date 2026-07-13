import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { DD_ASPECTS } from "@/config/ddAspects";
import { tailorSystem } from "@/lib/dd/prompts";
import type {
  DDAspectId, DDClassifiedDoc, DDExpectedDoc, DDTailorResult, DDTransactionType,
} from "@/types/dd";

const ASPECT_IDS = new Set<string>(DD_ASPECTS.map((a) => a.id));
const IMPORTANCE = new Set(["wajib", "penting", "opsional"]);

export function buildTailorPrompt(args: {
  entityName: string;
  transactionType: DDTransactionType;
  classified: DDClassifiedDoc[];
  expected: DDExpectedDoc[];
}): string {
  const sectorHints = args.classified.slice(0, 40).map((c) => `- ${c.docLabel}: ${c.summary}`).join("\n");
  return `Target: ${args.entityName}. Transaksi: ${args.transactionType.replace(/_/g, " ")}.

RINGKASAN DOKUMEN DATA ROOM (petunjuk sektor usaha):
${sectorHints}

CHECKLIST SAAT INI (id | dokumen):
${args.expected.map((e) => `- ${e.id} | ${e.label}`).join("\n")}

Tugas:
1) TAMBAHKAN item checklist sektoral yang wajar untuk sektor usaha target (mis. IUP/RKAB untuk pertambangan, PBG/SLF untuk properti, izin OJK untuk jasa keuangan). JANGAN mengulang item yang sudah ada.
2) SARANKAN item yang tampak tidak relevan untuk target ini (dengan alasan) — item TIDAK dihapus, hanya disarankan.

Kembalikan HANYA JSON:
{
  "added": [{ "id": "<aspectId>.<slug>", "aspectId": "...", "label": "...", "importance": "wajib|penting|opsional", "keywords": ["..."] }],
  "notApplicableSuggestions": [{ "expectedDocId": "...", "reason": "..." }]
}
Jika tidak ada tambahan, kembalikan array kosong.`;
}

export function parseTailorResponse(raw: string, stopReason: string | null): DDTailorResult {
  const clean = raw.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}?/);
  if (!match) throw new Error("Hasil tailoring bukan JSON");
  let jsonStr = match[0];
  if (stopReason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
  let p: { added?: unknown[]; notApplicableSuggestions?: unknown[] };
  try {
    p = JSON.parse(jsonStr);
  } catch {
    p = JSON.parse(repairTruncatedJson(jsonStr));
  }

  const added: DDExpectedDoc[] = [];
  for (const a of p.added ?? []) {
    const d = a as Record<string, unknown>;
    const aspectId = String(d.aspectId ?? "");
    const importance = String(d.importance ?? "penting");
    if (!ASPECT_IDS.has(aspectId)) continue; // silently drop malformed additions
    added.push({
      id: String(d.id ?? `${aspectId}.tambahan_${added.length}`),
      aspectId: aspectId as DDAspectId,
      label: String(d.label ?? ""),
      importance: (IMPORTANCE.has(importance) ? importance : "penting") as DDExpectedDoc["importance"],
      keywords: Array.isArray(d.keywords) ? d.keywords.map(String) : [],
      source: "ai_tailored",
    });
  }
  const notApplicableSuggestions = (p.notApplicableSuggestions ?? []).map((s) => {
    const o = s as Record<string, unknown>;
    return { expectedDocId: String(o.expectedDocId ?? ""), reason: String(o.reason ?? "") };
  }).filter((s) => s.expectedDocId);

  return { added, notApplicableSuggestions };
}

// Classification runs before tailoring, so tailored (AI-added) checklist items
// never appear in the classifier's candidate list and their expectedDocId is
// always null even when a doc plainly satisfies them. This pure re-match pass
// runs after tailoring: for every still-unmatched classified doc, look for an
// added doc in the SAME aspect whose keyword appears in the doc's label/file
// name/summary. First match wins. Cross-aspect matches are intentionally
// rejected to avoid false positives (a keyword coincidence in the wrong aspect
// is worse than leaving the doc unmatched).
export function rematchTailored(classified: DDClassifiedDoc[], added: DDExpectedDoc[]): DDClassifiedDoc[] {
  if (!added.length) return classified;
  return classified.map((doc) => {
    if (doc.expectedDocId !== null) return doc;
    const haystack = `${doc.docLabel} ${doc.fileName} ${doc.summary}`.toLowerCase();
    const match = added.find(
      (a) => a.aspectId === doc.aspectId && a.keywords.some((k) => k.trim() && haystack.includes(k.toLowerCase()))
    );
    return match ? { ...doc, expectedDocId: match.id } : doc;
  });
}

export async function tailorChecklist(
  client: Anthropic,
  args: {
    entityName: string; transactionType: DDTransactionType;
    classified: DDClassifiedDoc[]; expected: DDExpectedDoc[];
  }
): Promise<DDTailorResult> {
  const response = await client.messages.create({
    model: MODELS.ddTailoring,
    max_tokens: 2000,
    system: tailorSystem(),
    messages: [{ role: "user", content: buildTailorPrompt(args) }],
  });
  const raw = response.content.find((b) => b.type === "text")?.text ?? "";
  return parseTailorResponse(raw, response.stop_reason);
}
