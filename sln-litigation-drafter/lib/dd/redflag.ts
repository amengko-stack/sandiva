import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { redflagSystem } from "@/lib/dd/prompts";
import type { DDAspectId, DDExtractionRow, DDFinding, DDRegime, DDSeverity, DDTransactionType } from "@/types/dd";

const ASPECT_CHAR_CAP = 40_000;
const SEVERITIES = new Set(["kritis", "material", "minor"]);

export function buildRedFlagPrompt(args: {
  entityName: string; aspectId: DDAspectId; docsText: string; transactionType: DDTransactionType;
}): string {
  return `Entitas: ${args.entityName}. Aspek: ${args.aspectId.replace(/_/g, " ")}. Transaksi: ${args.transactionType.replace(/_/g, " ")}.

=== DOKUMEN ASPEK INI ===
${args.docsText.slice(0, ASPECT_CHAR_CAP)}
=== AKHIR DOKUMEN ===

Identifikasi red flag hukum yang NYATA dari dokumen di atas untuk transaksi ini (mis. izin kedaluwarsa, modal belum disetor penuh, aset dibebani jaminan, perkara berjalan, ketidaksesuaian anggaran dasar).
Kembalikan HANYA JSON:
{"findings":[{"severity":"kritis|material|minor","anchor":"kutipan verbatim (maks 40 kata)","sourceFile":"nama file","problem":"masalahnya","whyItMatters":"dampaknya bagi transaksi","suggestedFix":"tindak lanjut","regulationRefs":["UU 40/2007"]}]}
Bila tidak ada red flag, kembalikan {"findings":[]}.`;
}

export function parseRedFlagResponse(
  raw: string,
  stopReason: string | null,
  args: { entityId: string; aspectId: DDAspectId }
): DDFinding[] {
  const clean = raw.replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}?/);
  if (!match) throw new Error(`Hasil red-flag bukan JSON (${args.aspectId})`);
  let jsonStr = match[0];
  if (stopReason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
  let p: { findings?: unknown[] };
  try {
    p = JSON.parse(jsonStr);
  } catch {
    p = JSON.parse(repairTruncatedJson(jsonStr));
  }
  if (!Array.isArray(p.findings)) throw new Error(`Hasil red-flag tanpa "findings" (${args.aspectId})`);

  return p.findings.map((f, n) => {
    const o = f as Record<string, unknown>;
    const sev = String(o.severity ?? "");
    return {
      id: `${args.entityId}-risiko-${args.aspectId}-${n}`,
      entityId: args.entityId,
      aspectId: args.aspectId,
      dimension: "risiko" as const,
      severity: (SEVERITIES.has(sev) ? sev : "material") as DDSeverity,
      anchor: String(o.anchor ?? ""),
      sourceFile: o.sourceFile ? String(o.sourceFile) : null,
      problem: String(o.problem ?? ""),
      whyItMatters: String(o.whyItMatters ?? ""),
      suggestedFix: String(o.suggestedFix ?? ""),
      regulationRefs: Array.isArray(o.regulationRefs) ? o.regulationRefs.map(String) : undefined,
      verified: false,
      status: "open" as const,
    };
  });
}

export async function analyzeAspect(
  client: Anthropic,
  args: {
    entityId: string; entityName: string; aspectId: DDAspectId;
    docsText: string; transactionType: DDTransactionType; regime: DDRegime;
  }
): Promise<DDFinding[]> {
  const response = await client.messages.create({
    model: MODELS.ddRedFlag,
    max_tokens: 3000,
    system: redflagSystem(args.regime, args.entityName),
    messages: [{ role: "user", content: buildRedFlagPrompt(args) }],
  });
  const raw = response.content.find((b) => b.type === "text")?.text ?? "";
  return parseRedFlagResponse(raw, response.stop_reason, args);
}

// Every deal-triggered cell is already a risk — promote it without a model call.
export function promoteDealTriggeredCells(rows: DDExtractionRow[], entityId: string): DDFinding[] {
  const out: DDFinding[] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.dealTriggered) continue;
      out.push({
        id: `${entityId}-risiko-cell-${row.groupId}-${cell.fieldId}`,
        entityId,
        aspectId: "perjanjian_penting",
        dimension: "risiko",
        severity: "material",
        anchor: cell.verbatim,
        sourceFile: cell.sourceFile || row.memberFiles[0] || null,
        problem: `Klausul "${cell.fieldId.replace(/_/g, " ")}" dalam ${row.agreementLabel} terpicu oleh transaksi ini: ${cell.value}`,
        whyItMatters: "Klausul ini dapat mensyaratkan persetujuan/pemberitahuan pihak ketiga atau memicu wanprestasi bila transaksi dilanjutkan tanpa penanganan.",
        suggestedFix: "Masukkan sebagai condition precedent: minta persetujuan/waiver tertulis sebelum closing.",
        verified: false,
        status: "open",
      });
    }
  }
  return out;
}
