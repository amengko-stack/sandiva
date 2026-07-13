import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "@/config/models";
import { repairTruncatedJson } from "@/lib/json-repair";
import { DD_ASPECTS } from "@/config/ddAspects";
import { consolidateSystem } from "@/lib/dd/prompts";
import type {
  DDAspectRollup, DDClassifiedDoc, DDConsolidated, DDFinding, DDGapItem, DDTransaction,
} from "@/types/dd";

const ASPECT_ORDER = new Map(DD_ASPECTS.map((a, i) => [a.id, i]));

export function computeAspectRollup(gapsByEntity: Record<string, DDGapItem[]>): DDAspectRollup[] {
  const byAspect = new Map<string, DDAspectRollup>();
  for (const gaps of Object.values(gapsByEntity)) {
    for (const g of gaps) {
      const r = byAspect.get(g.aspectId) ?? {
        aspectId: g.aspectId, totalExpected: 0, present: 0, missing: 0,
        incomplete: 0, expired: 0, notApplicable: 0,
      };
      r.totalExpected++;
      if (g.status === "present") r.present++;
      else if (g.status === "missing") r.missing++;
      else if (g.status === "incomplete") r.incomplete++;
      else if (g.status === "expired") r.expired++;
      else r.notApplicable++;
      byAspect.set(g.aspectId, r);
    }
  }
  return Array.from(byAspect.values()).sort(
    (a, b) => (ASPECT_ORDER.get(a.aspectId) ?? 99) - (ASPECT_ORDER.get(b.aspectId) ?? 99)
  );
}

export async function consolidate(
  client: Anthropic,
  args: {
    transaction: DDTransaction;
    classifiedByEntity: Record<string, DDClassifiedDoc[]>;
    findingsByEntity: Record<string, DDFinding[]>;
    gapsByEntity: Record<string, DDGapItem[]>;
  }
): Promise<DDConsolidated> {
  const aspectRollup = computeAspectRollup(args.gapsByEntity);
  let crossEntityFindings: DDFinding[] = [];

  if (args.transaction.entities.length >= 2) {
    const perEntity = args.transaction.entities.map((e) => {
      const docs = (args.classifiedByEntity[e.id] ?? [])
        .map((c) => `- ${c.docLabel} (${c.aspectId}): ${c.summary} [pihak: ${c.parties.join(", ")}]`)
        .join("\n");
      const findings = (args.findingsByEntity[e.id] ?? [])
        .filter((f) => f.severity !== "minor")
        .map((f) => `- [${f.severity}] ${f.problem}`)
        .join("\n");
      return `=== ${e.name} (${e.id}) ===\nDOKUMEN:\n${docs}\nTEMUAN:\n${findings}`;
    }).join("\n\n");

    const prompt = `Transaksi: ${args.transaction.type.replace(/_/g, " ")} — ${args.transaction.name}.

${perEntity}

Temukan inkonsistensi LINTAS-ENTITAS. Kembalikan HANYA JSON:
{"findings":[{"severity":"kritis|material|minor","entityIds":["e1","e2"],"anchor":"bukti/kutipan ringkas dari ringkasan di atas","problem":"...","whyItMatters":"...","suggestedFix":"..."}]}
Bila tidak ada, {"findings":[]}.`;

    const response = await client.messages.create({
      model: MODELS.ddConsolidation,
      max_tokens: 3000,
      system: consolidateSystem(),
      messages: [{ role: "user", content: prompt }],
    });
    const raw = response.content.find((b) => b.type === "text")?.text ?? "";
    const match = raw.replace(/```json|```/g, "").match(/\{[\s\S]*\}?/);
    if (!match) throw new Error("Hasil konsolidasi bukan JSON");
    let jsonStr = match[0];
    if (response.stop_reason === "max_tokens") jsonStr = repairTruncatedJson(jsonStr);
    let p: { findings?: unknown[] };
    try {
      p = JSON.parse(jsonStr);
    } catch {
      p = JSON.parse(repairTruncatedJson(jsonStr));
    }
    crossEntityFindings = (p.findings ?? []).map((f, n) => {
      const o = f as Record<string, unknown>;
      const sev = String(o.severity ?? "material");
      return {
        id: `consolidated-konsistensi-${n}`,
        entityId: "consolidated",
        aspectId: null,
        dimension: "konsistensi" as const,
        severity: (["kritis", "material", "minor"].includes(sev) ? sev : "material") as DDFinding["severity"],
        anchor: String(o.anchor ?? ""),
        sourceFile: null,
        problem: `${String(o.problem ?? "")}${Array.isArray(o.entityIds) ? ` [entitas: ${o.entityIds.join(", ")}]` : ""}`,
        whyItMatters: String(o.whyItMatters ?? ""),
        suggestedFix: String(o.suggestedFix ?? ""),
        verified: false,
        status: "open" as const,
      };
    });
  }

  return {
    transactionType: args.transaction.type,
    crossEntityFindings,
    aspectRollup,
    generatedAt: new Date().toISOString(),
  };
}
