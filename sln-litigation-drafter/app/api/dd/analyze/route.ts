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

// Aspects run in concurrent waves rather than one-at-a-time: with up to 9
// aspects × ~20s each, a sequential loop alone approached the 300s ceiling and
// deterministically timed out on document-dense entities. Matches the
// CONCURRENCY=3 pattern already used by /api/dd/extract and /api/dd/recheck-ocr.
const ASPECT_CONCURRENCY = 3;

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

        // Checkpoint after every stage so a worst-case timeout never discards
        // findings already computed (mirrors extract/recheck-ocr's per-batch
        // persistence). JSON.stringify([]) is "[]" — always a non-empty body.
        const persist = () =>
          writeBlobText(ddKeys.findings(sessionId, entityId), JSON.stringify(findings));

        emit(controller, { type: "step", label: "Temuan gap (kelengkapan)" });
        findings.push(...gaps.map(gapToFinding).filter((f): f is DDFinding => f !== null));

        emit(controller, { type: "step", label: "Klausul terpicu transaksi" });
        findings.push(...promoteDealTriggeredCells(tables, entityId));

        const baseFindings = findings.slice();
        await persist();

        // Aspects with substantive documents; agreements are covered by the tables.
        const aspects = Array.from(new Set(classified.map((c) => c.aspectId))).filter(
          (a) => a !== "perjanjian_penting"
        ) as DDAspectId[];

        // Build the per-aspect jobs up front (applying the same <50-char skip
        // gate as before) so we can run them in concurrent waves.
        const aspectJobs = aspects
          .map((aspectId) => ({
            aspectId,
            docsText: classified
              .filter((c) => c.aspectId === aspectId)
              .map((c) => `=== ${c.fileName} ===\n${contentByFile.get(c.fileName) ?? ""}`)
              .join("\n\n"),
          }))
          .filter((j) => j.docsText.trim().length >= 50);

        const aspectFindings: (DDFinding[] | null)[] = new Array(aspectJobs.length).fill(null);
        const processAspect = async (i: number) => {
          try {
            aspectFindings[i] = await analyzeAspect(client, {
              entityId,
              entityName: entity.name,
              aspectId: aspectJobs[i].aspectId,
              docsText: aspectJobs[i].docsText,
              transactionType: txn.type,
            });
          } catch (e) {
            // Per-aspect soft-fail: one malformed aspect response must not abort
            // the whole run (mirrors extract/recheck-ocr per-item catch).
            console.error("[dd/analyze] aspect failed:", aspectJobs[i].aspectId, e instanceof Error ? e.message : e);
            aspectFindings[i] = [];
          }
        };

        for (let s = 0; s < aspectJobs.length; s += ASPECT_CONCURRENCY) {
          const indices = Array.from(
            { length: Math.min(ASPECT_CONCURRENCY, aspectJobs.length - s) },
            (_, k) => s + k
          );
          emit(controller, {
            type: "step",
            label: `Analisis aspek: ${indices.map((i) => aspectJobs[i].aspectId.replace(/_/g, " ")).join(", ")}`,
          });
          await Promise.allSettled(indices.map(processAspect));
          // Rebuild findings from the base snapshot + every completed aspect,
          // then checkpoint. Only the main task mutates `findings` (between
          // waves) — the concurrent tasks each write only their own index.
          findings = baseFindings.concat(
            ...aspectFindings.filter((a): a is DDFinding[] => a !== null)
          );
          await persist();
        }

        emit(controller, { type: "step", label: "Pemeriksaan keberlakuan peraturan" });
        const refs = collectRegulationRefs(findings);
        const currencyMap = await checkCurrency(refs);
        findings = applyCurrency(findings, currencyMap);
        await persist();

        emit(controller, { type: "step", label: "Verifikasi adversarial temuan kritis" });
        findings = await verifyFindings(client, findings, combined);

        await persist();
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
