import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { splitDocBlocks } from "@/lib/extract-format";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import { gapToFinding } from "@/lib/dd/gap-engine";
import {
  analyzeAspect, analyzeTransactionChapters, promoteDealTriggeredCells, selectAspectDocs,
} from "@/lib/dd/redflag";
import { collectRegulationRefs, checkCurrency, applyCurrency } from "@/lib/dd/currency";
import { carryReviewState } from "@/lib/dd/review-state";
import {
  canReuseAspect, parseAnalysisState, promptDigest, seenDigest, type DDAnalysisState,
} from "@/lib/dd/analysis-state";
import { redflagSystem, transactionAnalysisSystem } from "@/lib/dd/prompts";
import { verifyFindings } from "@/lib/dd/verify";
import { resolveRegime } from "@/lib/dd/regime";
import { checkQuote, isUngrounded } from "@/lib/dd/grounding";
import { badCitations, checkUUPTCitations } from "@/lib/dd/statute";
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
  const { sessionId, entityId, force } = (await req.json()) as {
    sessionId: string;
    entityId: string;
    /** Re-analyse every aspect even where the documents are unchanged. */
    force?: boolean;
  };
  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
    return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
  }

  const [txnRaw, combined, classifiedRaw, gapsRaw, tablesRaw, stateRaw] = await Promise.all([
    readBlobText(ddKeys.transaction(sessionId)),
    readBlobText(ddKeys.extracted(sessionId, entityId)),
    readBlobText(ddKeys.classified(sessionId, entityId)),
    readBlobText(ddKeys.gaps(sessionId, entityId)),
    readBlobText(ddKeys.tables(sessionId, entityId)),
    readBlobText(ddKeys.analysisState(sessionId, entityId)),
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
  const priorState = parseAnalysisState(stateRaw);

  const blocks = splitDocBlocks(combined);
  const contentByFile = new Map(blocks.map((b) => [b.fileName, b.content]));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        // The instructions this run would use. Hashing the system prompts makes any
        // change to the quote rule, the money rule, the analysis devices or the
        // statutory corrections invalidate the cache on its own — five UUPT
        // corrections would otherwise never have reached an existing matter, because
        // reuse turned only on the documents and those had not changed.
        const aspectPromptDigest = promptDigest(redflagSystem(regime, entity.name));
        const txnPromptDigest = promptDigest(transactionAnalysisSystem(regime, entity.name));
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
        // The previous run's per-sub-section analysis. A reused aspect must carry
        // its analysis text too, or its chapters would render as hollow scaffolding
        // while its findings table stayed full.
        const priorAnalysesRaw = await readBlobText(ddKeys.analyses(sessionId, entityId));
        const priorAnalyses: DDSubsectionAnalysis[] = priorAnalysesRaw
          ? (JSON.parse(priorAnalysesRaw) as DDSubsectionAnalysis[])
          : [];

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
        // Written with EVERY checkpoint, not once at the end.
        //
        // The first run over an 83-document data room reached the aspects and the
        // currency check and then hit the 300s ceiling during verification. The
        // state write sat after that, so nothing recorded which aspects had just
        // been analysed, and the next run would have redone all seven and timed out
        // in the same place — an incremental design that never gets to be
        // incremental. It now advances as the work completes.
        const nextState: DDAnalysisState = { aspects: { ...priorState.aspects } };
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
            writeBlobText(ddKeys.analysisState(sessionId, entityId), JSON.stringify(nextState)),
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
        const allJobs = aspects
          .map((aspectId) => ({
            aspectId,
            ...selectAspectDocs(
              classified
                .filter((c) => c.aspectId === aspectId)
                .map((c) => ({
                  fileName: c.fileName,
                  text: contentByFile.get(c.fileName) ?? "",
                  answersChecklistItem: c.expectedDocId !== null,
                }))
            ),
            docsDigest: "",
          }))
          .filter((j) => j.docsText.trim().length >= 50)
          // From what the model will actually be shown, not from the whole corpus:
          // a change to the cap or the packing rule must invalidate the cache too.
          .map((j) => ({ ...j, docsDigest: seenDigest(j.docsText, j.omitted) }));

        // An aspect whose documents are byte-identical to the last run keeps its
        // findings exactly as they were — ids, review state, grounding verdicts and
        // all. Re-deriving them would change their identities for no reason: two
        // consecutive runs over an unchanged data room kept only 21% of finding ids,
        // which is what made a re-run lose the lawyer's review and made the
        // supplement report issues as gone when nothing had gone.
        const priorCount = (a: DDAspectId) =>
          prior.filter((f) => f.dimension === "risiko" && f.aspectId === a).length;
        const reusable = force
          ? []
          : allJobs.filter((j) =>
              canReuseAspect({
                aspectId: j.aspectId,
                docsDigest: j.docsDigest,
                promptDigest: aspectPromptDigest,
                prior: priorState,
                priorFindingCount: priorCount(j.aspectId),
              })
            );
        const reusedAspects = new Set(reusable.map((j) => j.aspectId));
        const aspectJobs = allJobs.filter((j) => !reusedAspects.has(j.aspectId));

        // Carried verbatim, so their ids never move.
        const reusedFindings = prior.filter(
          (f) => f.dimension === "risiko" && f.aspectId !== null && reusedAspects.has(f.aspectId)
        );
        for (const a of priorAnalyses) {
          // "transaksi" analyses are carried by the transaction block below, which
          // has its own reuse test; here only aspect analyses are in scope.
          if (a.aspectId !== "transaksi" && reusedAspects.has(a.aspectId)) aspectAnalyses.push(a);
        }
        if (reusedAspects.size > 0) {
          emit(controller, {
            type: "step",
            label:
              `Dokumen tidak berubah untuk ${reusedAspects.size} aspek (` +
              `${Array.from(reusedAspects).join(", ").replace(/_/g, " ")}) — ` +
              `${reusedFindings.length} temuan dipertahankan apa adanya tanpa dianalisis ulang.`,
          });
        }
        if (aspectJobs.length === 0) {
          emit(controller, {
            type: "step",
            label: "Tidak ada aspek yang perlu dianalisis ulang; seluruh temuan dipertahankan.",
          });
        }

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

        // Say what could not be shown. Silent truncation once made a report tell the
        // client their data room lacked five financial statements they had supplied.
        const omittedAll = allJobs.filter((j) => j.omitted.length > 0);
        if (omittedAll.length > 0) {
          emit(controller, {
            type: "step",
            label:
              "Melebihi batas ukuran per aspek, dokumen berikut TIDAK diperiksa: " +
              omittedAll
                .map((j) => `${j.aspectId.replace(/_/g, " ")} (${j.omitted.join(", ")})`)
                .join("; "),
          });
        }
        // A reused aspect is current, not stale: reusedFindings carries it.
        reusedAspects.forEach((a) => unrefreshedAspects.delete(a));

        const aspectFindings: (DDFinding[] | null)[] = new Array(aspectJobs.length).fill(null);
        const failedAspects: DDAspectId[] = [];
        const processAspect = async (i: number) => {
          try {
            const res = await analyzeAspect(client, {
              entityId,
              entityName: entity.name,
              aspectId: aspectJobs[i].aspectId,
              docsText: aspectJobs[i].docsText,
              omittedDocs: aspectJobs[i].omitted,
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
            // Only now may this aspect's previous findings be replaced — and only
            // now is it recorded as analysed against these documents.
            unrefreshedAspects.delete(aspectJobs[i].aspectId);
            nextState.aspects[aspectJobs[i].aspectId] = {
              docsDigest: aspectJobs[i].docsDigest,
              promptDigest: aspectPromptDigest,
              analysedAtISO: new Date().toISOString(),
            };
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
            reusedFindings,
            ...aspectFindings.filter((a): a is DDFinding[] => a !== null),
            retainedPrior()
          );
          await persist();
        }

        // The transaction chapters. Nothing analysed these until now: Stage 5 asks
        // for sub-section analysis per aspect, and a transaction chapter belongs to
        // no aspect, so a live dissolution report came out with all twelve of its
        // transaction sub-sections empty while the nine aspect chapters were full.
        //
        // Reused on the same terms as an aspect — keyed on the whole corpus, since
        // these chapters read across all of it rather than one aspect's documents.
        const TXN_KEY = "transaksi";
        // Grouped by chapter: asking for all of them in one response truncated at
        // max_tokens and silently lost the last six sub-sections.
        const txnGroups: string[][] = [];
        const txnSubs: string[] = [];
        for (const ch of chapterPlan) {
          if (ch.kind !== "transaksi") continue;
          const titles = ch.subs.map((sub) => sub.title);
          if (titles.length === 0) continue;
          txnGroups.push(titles);
          for (const t of titles) txnSubs.push(t);
        }
        if (txnSubs.length > 0) {
          const txnDigest = createHash("sha256")
            .update(txnSubs.join("|") + "::" + combined)
            .digest("hex")
            .slice(0, 32);
          const priorTxn = priorAnalyses.filter((a) => a.aspectId === "transaksi");
          // Reuse only a COMPLETE previous result. A truncated response once left six
          // of seventeen sub-sections unanalysed, and reusing on "some exist" would
          // have frozen that hole in place: the digest never changes while the
          // documents do not, so the missing chapters would never be retried and the
          // report would print "[BELUM DIANALISIS]" for the rest of the matter.
          const priorTitles = new Set(priorTxn.map((a) => a.subsectionTitle));
          const priorCovers = txnSubs.every((t) => priorTitles.has(t));
          const reuseTxn =
            !force &&
            priorState.aspects[TXN_KEY] !== undefined &&
            priorState.aspects[TXN_KEY].docsDigest === txnDigest &&
            priorState.aspects[TXN_KEY].promptDigest === txnPromptDigest &&
            priorCovers;
          if (reuseTxn) {
            for (const a of priorTxn) aspectAnalyses.push(a);
            emit(controller, {
              type: "step",
              label: `Bab transaksi tidak berubah — ${priorTxn.length} sub-bagian dipertahankan.`,
            });
          } else {
            emit(controller, { type: "step", label: "Analisis bab transaksi" });
            try {
              const settled = await Promise.allSettled(
                txnGroups.map((subsections) =>
                  analyzeTransactionChapters(client, {
                    entityId,
                    entityName: entity.name,
                    docsText: combined,
                    transactionType: txn.type,
                    regime,
                    subsections,
                  })
                )
              );
              const txnAnalyses = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
              for (const a of txnAnalyses) aspectAnalyses.push(a);
              nextState.aspects[TXN_KEY] = {
                docsDigest: txnDigest,
                promptDigest: txnPromptDigest,
                analysedAtISO: new Date().toISOString(),
              };
              const missing = txnSubs.length - txnAnalyses.length;
              if (missing > 0) {
                emit(controller, {
                  type: "step",
                  label: `${missing} dari ${txnSubs.length} sub-bagian bab transaksi tidak terisi dan akan ditandai "[BELUM DIANALISIS]" pada laporan.`,
                });
              }
            } catch (e) {
              // Soft-fail like an aspect: the rest of the report is still worth
              // producing, and the builder marks every unfilled sub-section.
              console.error("[dd/analyze] transaction chapters failed:", e instanceof Error ? e.message : e);
              emit(controller, {
                type: "step",
                label: 'Analisis bab transaksi gagal; sub-bagiannya ditandai "[BELUM DIANALISIS]".',
              });
            }
            await persist();
          }
        }

        emit(controller, { type: "step", label: "Pemeriksaan keberlakuan peraturan" });
        const refs = collectRegulationRefs(findings);
        const currencyMap = await checkCurrency(refs);
        findings = applyCurrency(findings, currencyMap);
        await persist();

        // Do the articles the report cites actually exist as written?
        //
        // Reading a live report found "UUPT Pasal 142 ayat (2) huruf c" carrying a
        // rule attributed to it; that ayat has only a and b. Nothing looked: the
        // quote check verifies text against documents, and the currency check
        // confirms a regulation is in force, which UUPT is. Neither reads the
        // article. This catches a citation that cannot be right whatever it claims.
        {
          // Attached to the finding or the analysis that makes the claim, not only
          // reported to whoever is watching the run. A citation to an article that
          // does not exist is exactly the kind of thing a reader cannot catch, and
          // until now the only trace of it was a line in the operator's log.
          const refsOf = (text: string) => badCitations(checkUUPTCitations(text)).map((b) => b.ref);
          findings = findings.map((f) => {
            const issues = refsOf(
              [f.problem, f.whyItMatters, f.legalConsequence ?? "", (f.regulationRefs ?? []).join(" ")].join(" ")
            );
            return issues.length > 0 ? { ...f, citationIssues: issues } : f;
          });
          for (let i = 0; i < aspectAnalyses.length; i++) {
            const issues = refsOf(aspectAnalyses[i].analysis.join(" "));
            if (issues.length > 0) aspectAnalyses[i] = { ...aspectAnalyses[i], citationIssues: issues };
          }
          const all = Array.from(
            new Set(
              findings
                .flatMap((f) => f.citationIssues ?? [])
                .concat(aspectAnalyses.flatMap((a) => a.citationIssues ?? []))
            )
          );
          if (all.length > 0) {
            emit(controller, {
              type: "step",
              label:
                `PERIKSA: ${all.length} rujukan UUPT tidak ada sebagaimana ditulis — ` +
                all.join("; ") +
                ". Ditandai pada laporan dan wajib diperbaiki sebelum diandalkan.",
            });
          }
          await persist();
        }

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
