import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { DD_ASPECTS } from "@/config/ddAspects";
import { classifySystem } from "@/lib/dd/prompts";
import type { DDAspectId, DDClassifiedDoc, DDConfidence, DDExpectedDoc, DDTransactionType } from "@/types/dd";

const DOC_CHAR_CAP = 15_000;
const ASPECT_IDS = new Set<string>(DD_ASPECTS.map((a) => a.id));
const CONFIDENCE = new Set(["tinggi", "sedang", "rendah"]);

export function buildClassifyPrompt(args: {
  fileName: string;
  content: string;
  entityName: string;
  transactionType: DDTransactionType;
  expected: DDExpectedDoc[];
}): string {
  const checklist = args.expected
    .map((e) => `- ${e.id} | ${e.label} | kata kunci: ${e.keywords.join(", ")}`)
    .join("\n");
  return `Konteks: uji tuntas atas ${args.entityName} untuk transaksi ${args.transactionType.replace(/_/g, " ")}.

DAFTAR ITEM CHECKLIST (id | dokumen | kata kunci):
${checklist}

DOKUMEN: ${args.fileName}
=== ISI DOKUMEN ===
${args.content.slice(0, DOC_CHAR_CAP)}
=== AKHIR ISI DOKUMEN ===

Klasifikasikan dokumen ini dan kembalikan HANYA JSON:
{
  "aspectId": "salah satu: ${DD_ASPECTS.map((a) => a.id).join(" | ")}",
  "expectedDocId": "id item checklist yang PALING dipenuhi dokumen ini, atau null bila tidak ada",
  "docLabel": "judul dokumen yang ringkas dan manusiawi",
  "docDate": "tanggal utama dokumen: YYYY-MM-DD / YYYY-MM / YYYY, atau null",
  "parties": ["pihak-pihak yang disebut"],
  "summary": "1-2 kalimat isi dokumen",
  "confidence": "tinggi | sedang | rendah",
  "reasoning": "alasan singkat klasifikasi"
}`;
}

export function parseClassifyResponse(
  raw: string,
  stopReason: string | null,
  args: { fileName: string; entityId: string; expected: DDExpectedDoc[] }
): DDClassifiedDoc {
  const clean = raw.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}?/);
  if (!match) throw new Error(`Hasil klasifikasi bukan JSON (${args.fileName})`);
  let jsonStr = match[0];
  if (stopReason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    // One repair attempt even without max_tokens — model may emit a dangling brace.
    try {
      p = JSON.parse(repairTruncatedJson(jsonStr)) as Record<string, unknown>;
    } catch {
      throw new Error(`Hasil klasifikasi tidak dapat diparsing (${args.fileName})`);
    }
  }

  const knownIds = new Set(args.expected.map((e) => e.id));
  const aspectRaw = String(p.aspectId ?? "");
  const expectedRaw = p.expectedDocId == null ? null : String(p.expectedDocId);

  return {
    fileName: args.fileName,
    entityId: args.entityId,
    aspectId: (ASPECT_IDS.has(aspectRaw) ? aspectRaw : "perjanjian_penting") as DDAspectId,
    expectedDocId: expectedRaw && knownIds.has(expectedRaw) ? expectedRaw : null,
    docLabel: String(p.docLabel ?? args.fileName),
    docDate: p.docDate == null ? null : String(p.docDate),
    parties: Array.isArray(p.parties) ? p.parties.map(String) : [],
    summary: String(p.summary ?? ""),
    confidence: (CONFIDENCE.has(String(p.confidence)) ? String(p.confidence) : "rendah") as DDConfidence,
    reasoning: String(p.reasoning ?? ""),
  };
}

export async function classifyDoc(
  client: Anthropic,
  args: {
    fileName: string; content: string; entityId: string; entityName: string;
    transactionType: DDTransactionType; expected: DDExpectedDoc[];
  }
): Promise<DDClassifiedDoc> {
  const response = await client.messages.create({
    model: MODELS.ddClassification,
    max_tokens: 800,
    system: classifySystem(),
    messages: [{ role: "user", content: buildClassifyPrompt({ ...args, entityName: args.entityName }) }],
  });
  const raw = response.content.find((b) => b.type === "text")?.text ?? "";
  return parseClassifyResponse(raw, response.stop_reason, args);
}
