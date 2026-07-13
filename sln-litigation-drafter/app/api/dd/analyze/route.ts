import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { splitDocBlocks } from "@/lib/extract-format";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { gapToFinding } from "@/lib/dd/gap-engine";
import { analyzeAspect, promoteDealTriggeredCells } from "@/lib/dd/redflag";
import { collectRegulationRefs, checkCurrency, applyCurrency } from "@/lib/dd/currency";
import { verifyFindings } from "@/lib/dd/verify";
import type {
  DDAspectId, DDClassifiedDoc, DDExtractionRow, DDFinding, DDGapItem, DDTransaction,
} from "@/types/dd";

export const maxDuration = 300;

const enc = new TextEncoder();
type Msg = { type: "step"; label: string } | { type: "done"; findings: DDFinding[] } | { type: "error"; message: string };
const emit = (c: ReadableStreamDefaultController<Uint8Array>, m: Msg) =>
  c.enqueue(enc.encode(JSON.stringify(m) + "\n"));

export async function POST(req: NextRequest) {
  const { sessionId, entityId } = (await req.json()) as { sessionId: string; entityId: string };
  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
    return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
  }

  const [txnRaw, combined, classifiedRaw, gapsRaw, tablesRaw] = await Promise.all([
    readBlobText(ddKeys.transaction(sessionId)),
    readBlobText(ddKeys.extracted(sessionId, entityId)),
    readBlobText(ddKeys.classified(sessionId, entityId)),
    readBlobText(ddKeys.gaps(sessionId, entityId)),
    readBlobText(ddKeys.tables(sessionId, entityId)),
  ]);
  if (!txnRaw || !combined || !classifiedRaw || !gapsRaw) {
    return NextResponse.json({ error: "Selesaikan klasifikasi & gap entitas ini dahulu." }, { status: 400 });
  }
  const txn = JSON.parse(txnRaw) as DDTransaction;
  const entity = txn.entities.find((e) => e.id === entityId);
  if (!entity) return NextResponse.json({ error: "Entitas tidak dikenal." }, { status: 400 });
  const classified = JSON.parse(classifiedRaw) as DDClassifiedDoc[];
  const gaps = JSON.parse(gapsRaw) as DDGapItem[];
  const tables = tablesRaw ? (JSON.parse(tablesRaw) as DDExtractionRow[]) : [];

  const blocks = splitDocBlocks(combined);
  const contentByFile = new Map(blocks.map((b) => [b.fileName, b.content]));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        let findings: DDFinding[] = [];

        emit(controller, { type: "step", label: "Temuan gap (kelengkapan)" });
        findings.push(...gaps.map(gapToFinding).filter((f): f is DDFinding => f !== null));

        emit(controller, { type: "step", label: "Klausul terpicu transaksi" });
        findings.push(...promoteDealTriggeredCells(tables, entityId));

        // Aspects with substantive documents; agreements are covered by the tables.
        const aspects = Array.from(new Set(classified.map((c) => c.aspectId))).filter(
          (a) => a !== "perjanjian_penting"
        ) as DDAspectId[];
        for (const aspectId of aspects) {
          emit(controller, { type: "step", label: `Analisis aspek: ${aspectId.replace(/_/g, " ")}` });
          const docsText = classified
            .filter((c) => c.aspectId === aspectId)
            .map((c) => `=== ${c.fileName} ===\n${contentByFile.get(c.fileName) ?? ""}`)
            .join("\n\n");
          if (docsText.trim().length < 50) continue;
          findings.push(
            ...(await analyzeAspect(client, {
              entityId, entityName: entity.name, aspectId, docsText, transactionType: txn.type,
            }))
          );
        }

        emit(controller, { type: "step", label: "Pemeriksaan keberlakuan peraturan" });
        const refs = collectRegulationRefs(findings);
        const currencyMap = await checkCurrency(refs);
        findings = applyCurrency(findings, currencyMap);

        emit(controller, { type: "step", label: "Verifikasi adversarial temuan kritis" });
        findings = await verifyFindings(client, findings, combined);

        await writeBlobText(ddKeys.findings(sessionId, entityId), JSON.stringify(findings));
        emit(controller, { type: "done", findings });
      } catch (e) {
        try { emit(controller, { type: "error", message: e instanceof Error ? e.message : "Error" }); } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
  });
}
