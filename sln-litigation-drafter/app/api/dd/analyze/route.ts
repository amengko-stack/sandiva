import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { splitDocBlocks } from "@/lib/extract-format";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { gapToFinding } from "@/lib/dd/gap-engine";
import { analyzeAspect, promoteDealTriggeredCells } from "@/lib/dd/redflag";
import { collectRegulationRefs, checkCurrency, applyCurrency } from "@/lib/dd/currency";
import { carryReviewState } from "@/lib/dd/review-state";
import { verifyFindings } from "@/lib/dd/verify";
import { resolveRegime } from "@/lib/dd/regime";
import { checkQuote, isUngrounded } from "@/lib/dd/grounding";
import { chapterForAspect, planChapters } from "@/config/ddChapters";
import type {
  DDAspectId, DDClassifiedDoc, DDExtractionRow, DDFinding, DDGapItem, DDSubsectionAnalysis, DDTransaction,
} from "@/types/dd";

export const maxDuration = 300;

// Aspects run in concurrent waves rather than one-at-a-time: with up to 9
// aspects × ~20s each, a sequential loop alone approached the 300s ceiling and
// deterministically timed out on document-dense entities. Matches the
// CONCURRENCY=3 pattern already used by /api/dd/extract and /api/dd/recheck-ocr.
// Raised from 3 after a live run overran the 300s ceiling: the same call now
// returns per-sub-section analysis as well as findings, so max_tokens went
// 3000 -> 8000 and each wave costs roughly 2.7x what it did. Running the
// aspects in ONE wave instead of two is what buys the budget back. The steps
// reached the currency check but not adversarial verification at 295s.
const ASPECT_CONCURRENCY = 6;

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
  const regime = resolveRegime(entity);

  const blocks = splitDocBlocks(combined);
  const contentByFile = new Map(blocks.map((b) => [b.fileName, b.content]));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        let findings: DDFinding[] = [];
        // Declared before persist(), which closes over it and runs before the
        // aspect loop — referencing it later would hit the temporal dead zone.
        const aspectAnalyses: DDSubsectionAnalysis[] = [];

        // The lawyer's review of the PREVIOUS run, read before anything here
        // overwrites it. Re-running this stage is the normal path once documents
        // arrive after the interim report, and it used to discard every dismissal
        // and every rewording. Carried by id, which is now derived from a finding's
        // own content rather than its position in the model's output.
        const priorRaw = await readBlobText(ddKeys.findings(sessionId, entityId));
        const prior: DDFinding[] = priorRaw ? (JSON.parse(priorRaw) as DDFinding[]) : [];

        // Aspects whose model findings this run has NOT successfully replaced —
        // either not reached yet, or failed. Their previous findings are retained,
        // because "absent from a partial or failed run" is not evidence that the
        // issue is gone. Without this, the first checkpoint runs before any aspect
        // has been analysed, so every previously reviewed model finding would look
        // dropped and be written away; a timeout right after that checkpoint would
        // lose both the findings and the review permanently. A failed aspect used
        // to be indistinguishable from one that found nothing, which erased that
        // aspect's findings on a transient model or parse error.
        // Seeded from the previous run's own aspects, BEFORE the first checkpoint.
        // Seeding later (from the job list) would leave that first checkpoint with
        // nothing retained — the exact window in which a timeout loses the review.
        const unrefreshedAspects = new Set<DDAspectId>();
        for (const f of prior) {
          if (f.dimension === "risiko" && f.aspectId !== null) unrefreshedAspects.add(f.aspectId);
        }
        const retainedPrior = (): DDFinding[] =>
          prior.filter(
            (f) =>
              f.dimension === "risiko" &&
              f.aspectId !== null &&
              unrefreshedAspects.has(f.aspectId)
          );

        // Checkpoint after every stage so a worst-case timeout never discards
        // findings already computed (mirrors extract/recheck-ocr's per-batch
        // persistence). JSON.stringify([]) is "[]" — always a non-empty body.
        // Both are checkpointed together: a maxDuration kill runs no catch or
        // finally, so anything not written before the kill is simply lost.
        //
        // The carry happens inside persist, not once at the end, so a checkpoint
        // written just before a timeout kill also keeps the review rather than
        // saving a stripped copy over it.
        // `final` gates the two things that are only true of a complete run: the
        // count of reviewed findings this examination no longer raises, and the
        // absence of any retained prior findings. Reporting either from a partial
        // checkpoint would state that a finding is gone when its aspect simply had
        // not run yet.
        const persist = (final = false) => {
          const carried = carryReviewState(findings, prior);
          findings = carried.findings;
          if (final && (carried.carried > 0 || carried.dropped > 0)) {
            emit(controller, {
              type: "step",
              label:
                `Review sebelumnya dipertahankan: ${carried.carried} temuan` +
                (carried.dropped > 0
                  ? `; ${carried.dropped} temuan yang sudah ditelaah tidak lagi muncul pada pemeriksaan ini`
                  : ""),
            });
          }
          return Promise.all([
            writeBlobText(ddKeys.findings(sessionId, entityId), JSON.stringify(findings)),
            writeBlobText(ddKeys.analyses(sessionId, entityId), JSON.stringify(aspectAnalyses)),
          ]);
        };

        emit(controller, { type: "step", label: "Temuan gap (kelengkapan)" });
        findings.push(...gaps.map(gapToFinding).filter((f): f is DDFinding => f !== null));

        emit(controller, { type: "step", label: "Klausul terpicu transaksi" });
        findings.push(...promoteDealTriggeredCells(tables, entityId));

        const baseFindings = findings.slice();
        // Prior model findings ride along until their aspect is actually re-analysed.
        findings = baseFindings.concat(retainedPrior());
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

        // The chapter plan tells each aspect which sub-sections it must fill.
        // Without this the analysis chapters render as hollow scaffolding.
        // The format and client role MUST match what the builder will use: the
        // sub-section titles differ per format, and analyses are placed by title.
        // Planning with the default here while the builder plans with the chosen
        // format means nothing matches, and every sub-section falls back to
        // "belum dapat dianalisis" — the empty-chapters defect, reintroduced for
        // any non-default format.
        const chapterPlan = planChapters({
          transactionType: txn.type,
          regime,
          presentAspects: Array.from(new Set(classified.map((c) => c.aspectId))) as DDAspectId[],
          format: txn.reportFormat,
          clientRole: txn.clientRole,
          transactionImplications: txn.reportOptions?.transactionImplications,
        });
        const subsectionsFor = (aspectId: DDAspectId): string[] => {
          const ch = chapterForAspect(chapterPlan, aspectId);
          if (!ch) return [];
          return ch.subs.filter((sub) => !sub.findings).map((sub) => sub.title);
        };

        // An aspect the previous run covered but this one does not examine at all —
        // its documents are gone from the classification — is not "unrefreshed", it
        // is out of scope now, so its old findings must not ride along.
        const jobAspects = new Set(aspectJobs.map((j) => j.aspectId));
        Array.from(unrefreshedAspects).forEach((a) => {
          if (!jobAspects.has(a)) unrefreshedAspects.delete(a);
        });
        for (const j of aspectJobs) unrefreshedAspects.add(j.aspectId);

        const aspectFindings: (DDFinding[] | null)[] = new Array(aspectJobs.length).fill(null);
        const failedAspects: DDAspectId[] = [];
        const processAspect = async (i: number) => {
          try {
            const res = await analyzeAspect(client, {
              entityId,
              entityName: entity.name,
              aspectId: aspectJobs[i].aspectId,
              docsText: aspectJobs[i].docsText,
              transactionType: txn.type,
              regime,
              subsections: subsectionsFor(aspectJobs[i].aspectId),
            });
            // Verify each quote against the document it names, before the finding
            // can reach the report as fact. Costs nothing: the text is already here.
            aspectFindings[i] = res.findings.map((f) => {
              if (!f.anchor || !f.sourceFile) return f;
              const g = checkQuote(f.anchor, contentByFile.get(f.sourceFile));
              return { ...f, grounding: { verdict: g.verdict, coverage: g.coverage, note: g.note } };
            });
            for (const a of res.analyses) aspectAnalyses.push(a);
            // Only now may this aspect's previous findings be replaced.
            unrefreshedAspects.delete(aspectJobs[i].aspectId);
          } catch (e) {
            // Per-aspect soft-fail: one malformed aspect response must not abort
            // the whole run (mirrors extract/recheck-ocr per-item catch).
            console.error("[dd/analyze] aspect failed:", aspectJobs[i].aspectId, e instanceof Error ? e.message : e);
            // Left null and still in unrefreshedAspects: a transient model or parse
            // failure must not read as "this aspect was examined and found nothing",
            // which would delete the aspect's earlier findings and the review on
            // them. The previous findings are retained and the failure is reported.
            failedAspects.push(aspectJobs[i].aspectId);
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
            ...aspectFindings.filter((a): a is DDFinding[] => a !== null),
            retainedPrior()
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

        if (failedAspects.length > 0) {
          emit(controller, {
            type: "step",
            label:
              `Aspek yang gagal dianalisis pada pemeriksaan ini: ${failedAspects.join(", ").replace(/_/g, " ")}. ` +
              `Temuan aspek tersebut dari pemeriksaan sebelumnya dipertahankan dan BELUM diperbarui.`,
          });
        }
        await persist(true);
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
