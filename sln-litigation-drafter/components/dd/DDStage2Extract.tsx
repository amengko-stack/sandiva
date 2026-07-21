"use client";

import { useState } from "react";
import { useDD } from "@/context/DDContext";
import DDCoveragePanel from "@/components/dd/DDCoveragePanel";
import { matchOcrFiles, type OcrMatch } from "@/lib/dd/ocr-match";
import type { ExtractReport, FileEntry } from "@/types";

interface EntityRun {
  log: string[];
  report: ExtractReport | null;
  running: boolean;
  done: boolean;
  retrying: boolean;
  // OCR-recheck sub-flow: folder input → listing matched against the report's
  // perlu_ocr names → one-shot recheck POST.
  ocrFolder: string;
  ocrLoading: boolean;
  ocrMatches: OcrMatch[] | null;
  // Count of OCR-folder files dropped because they already match a "selesai"
  // report entry (by name or normalized base) — re-reading the same OCR
  // folder twice must not offer them again as "Baru".
  ocrSkippedCount: number;
  ocrExtracting: boolean;
}

const emptyRun = (): EntityRun => ({
  log: [], report: null, running: false, done: false,
  retrying: false, ocrFolder: "", ocrLoading: false, ocrMatches: null, ocrSkippedCount: 0, ocrExtracting: false,
});

// Mirrors the normalization lib/dd/ocr-match.ts uses internally (not exported
// there) — needed here to recognize an OCR-folder file as a duplicate of an
// already-imported ("selesai") report entry even when extensions/OCR suffixes differ.
function normalizeOcrBase(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[\s_-]*\(\s*ocr\s*\)$/, "")
    .replace(/[\s_-]+ocr$/, "")
    .trim();
}

// Shared reminder appended whenever Stage 2's extracted content changes after
// downstream stages may already have run against the old content.
const STALE_DOWNSTREAM_NOTICE = "Dokumen berubah — jalankan ulang Klasifikasi (Stage 3) untuk entitas ini.";

// Caps how many files go into a single /api/dd/extract request so a very
// large data room doesn't run into the route's maxDuration (300s). Chunks
// beyond the first are sent with appendToExisting so the server prepends
// prior chunks' text/report instead of overwriting them.
const EXTRACT_BATCH_SIZE = 60;

export default function DDStage2Extract() {
  const { state, dispatch } = useDD();
  const [runs, setRuns] = useState<Record<string, EntityRun>>({});
  const t = state.transaction;
  if (!t) return <div>Selesaikan Stage 1 dahulu.</div>;

  const patch = (eid: string, p: Partial<EntityRun>) =>
    setRuns((r) => ({ ...r, [eid]: { ...(r[eid] ?? emptyRun()), ...p } }));

  // Functional update — appending via a stale `runs` closure inside the SSE
  // read loop would drop log lines.
  const appendLog = (eid: string, entry: string) =>
    setRuns((r) => {
      const cur = r[eid] ?? emptyRun();
      return { ...r, [eid]: { ...cur, log: [...cur.log, entry] } };
    });

  // Every action (initial extract, retry-failed, OCR recheck) ends by
  // re-pulling the server-side report so the coverage panel always reflects
  // the merged state, not just this run's events.
  const refreshReport = async (eid: string): Promise<ExtractReport | null> => {
    const rep = await fetch(`/api/dd/check-session?sessionId=${state.sessionId}&entityId=${eid}&artifact=report`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const report: ExtractReport | null = rep?.report ?? null;
    if (report) patch(eid, { report });
    return report;
  };

  // Shared SSE reader for /api/dd/extract (initial chunks and retry-failed):
  // streams per-file events into the entity log; onComplete fires when the
  // server signals the run finished.
  const streamExtract = async (
    eid: string,
    payload: { files: FileEntry[]; appendToExisting: boolean },
    onComplete?: () => void
  ): Promise<{ successCount: number }> => {
    const res = await fetch("/api/dd/extract", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, entityId: eid, files: payload.files, appendToExisting: payload.appendToExisting }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Gagal memulai ekstraksi");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let successCount = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const ev of events) {
        const line = ev.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const msg = JSON.parse(line.slice(6));
        if (msg.type === "done") { appendLog(eid, `✓ ${msg.name} (${msg.charCount} kar)`); successCount++; }
        if (msg.type === "error") appendLog(eid, `✗ ${msg.name}: ${msg.reason}`);
        if (msg.type === "ocr_required") appendLog(eid, `⚠ ${msg.name}: perlu OCR`);
        if (msg.type === "complete") onComplete?.();
        if (msg.error) throw new Error(msg.error);
      }
    }
    return { successCount };
  };

  const extractEntity = async (eid: string) => {
    const entity = t.entities.find((e) => e.id === eid)!;

    // "Ekstrak ulang" overwrites the whole report from chunk 0 (appendToExisting
    // false) — if the current report holds entries added outside entity.files
    // (i.e. documents brought in via an OCR recheck), that work would be
    // silently discarded. Confirm first; fetch the report if not loaded yet.
    let existingReport = runs[eid]?.report ?? null;
    if (!existingReport) existingReport = await refreshReport(eid);
    if (existingReport) {
      const entityFileNames = new Set(entity.files.map((f) => f.name));
      const ocrAddedCount = existingReport.files.filter((f) => !entityFileNames.has(f.name)).length;
      if (ocrAddedCount > 0) {
        const ok = window.confirm(
          `Ekstrak ulang akan menimpa seluruh hasil sebelumnya, termasuk ${ocrAddedCount} dokumen hasil OCR yang sudah ditambahkan. Lanjutkan?`
        );
        if (!ok) return;
      }
    }

    patch(eid, { running: true, log: [] });
    try {
      const files = entity.files;
      // Chunk into batches of ≤60 so a large data room never sends more files
      // in one request than the route can extract inside its maxDuration.
      // ≤60 files: single chunk, identical to the pre-chunking request shape.
      const chunks: FileEntry[][] =
        files.length > EXTRACT_BATCH_SIZE
          ? Array.from(
              { length: Math.ceil(files.length / EXTRACT_BATCH_SIZE) },
              (_, i) => files.slice(i * EXTRACT_BATCH_SIZE, (i + 1) * EXTRACT_BATCH_SIZE)
            )
          : [files];

      for (let c = 0; c < chunks.length; c++) {
        const isLastChunk = c === chunks.length - 1;
        // Progress only counts as "extracted" once every chunk has completed —
        // marking it after an intermediate chunk would let Stage 3 start on
        // a partially-extracted entity. A full extract replaces the entity's
        // content, so downstream stages' cached results are now stale.
        await streamExtract(eid, { files: chunks[c], appendToExisting: c > 0 }, () => {
          if (isLastChunk) {
            patch(eid, { done: true });
            dispatch({
              type: "MARK_PROGRESS", entityId: eid,
              patch: { extracted: true, classified: false, tabled: false, analyzed: false },
            });
            appendLog(eid, STALE_DOWNSTREAM_NOTICE);
          }
        });
      }
      // Pull the (cumulative) report for the coverage panel.
      await refreshReport(eid);
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      patch(eid, { running: false });
    }
  };

  // Re-extract only the report's "gagal" files (e.g. transient SharePoint
  // errors) — appendToExisting so the server merges rather than overwrites.
  const retryFailed = async (eid: string) => {
    const entity = t.entities.find((e) => e.id === eid)!;
    const report = runs[eid]?.report;
    if (!report) return;
    const failedNames = new Set(report.files.filter((f) => f.status === "gagal").map((f) => f.name));
    const files = entity.files.filter((f) => failedNames.has(f.name));
    if (files.length === 0) {
      appendLog(eid, "✗ Dokumen gagal tidak ditemukan di daftar file entitas — muat ulang daftar file di Stage 1.");
      return;
    }
    patch(eid, { retrying: true });
    try {
      appendLog(eid, `— Coba ulang ${files.length} dokumen gagal —`);
      const { successCount } = await streamExtract(eid, { files, appendToExisting: true });
      await refreshReport(eid);
      // Any successful retry changes the entity's extracted content — Stages
      // 3–6 must not keep showing results computed against the old text.
      if (successCount > 0) {
        dispatch({
          type: "MARK_PROGRESS", entityId: eid,
          patch: { extracted: true, classified: false, tabled: false, analyzed: false },
        });
        appendLog(eid, STALE_DOWNSTREAM_NOTICE);
      }
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      patch(eid, { retrying: false });
    }
  };

  // Step 1 of OCR recheck — list the OCR-output folder and match its files
  // against the report's perlu_ocr names (exact, then base-name/_ocr-suffix).
  const readOcrFolder = async (eid: string) => {
    const run = runs[eid];
    const report = run?.report;
    const folder = (run?.ocrFolder ?? "").trim();
    if (!report || !folder) return;
    patch(eid, { ocrLoading: true, ocrMatches: null, ocrSkippedCount: 0 });
    try {
      const res = await fetch("/api/sharepoint/list-files", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: folder }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Gagal membaca folder OCR");
      const listing = (data?.files ?? []) as FileEntry[];
      if (listing.length === 0) throw new Error("Tidak ada dokumen ditemukan di folder OCR ini.");
      const perluOcrNames = report.files.filter((f) => f.status === "perlu_ocr").map((f) => f.name);
      const rawMatches = matchOcrFiles(listing.map((f) => ({ name: f.name, path: f.path })), perluOcrNames);
      // Idempotency: an unmatched OCR file (no perlu_ocr slot to replace) whose
      // name or normalized base already appears as a "selesai" report entry was
      // already imported by a previous recheck — re-reading the same OCR folder
      // must not offer it again as "Baru" (which would re-import it as a duplicate).
      const importedNames = new Set(report.files.filter((f) => f.status === "selesai").map((f) => f.name));
      const importedBases = new Set(
        report.files.filter((f) => f.status === "selesai").map((f) => normalizeOcrBase(f.name))
      );
      let ocrSkippedCount = 0;
      const matches = rawMatches.filter((m) => {
        if (m.replacesName) return true;
        const isDup = importedNames.has(m.name) || importedBases.has(normalizeOcrBase(m.name));
        if (isDup) ocrSkippedCount++;
        return !isDup;
      });
      patch(eid, { ocrMatches: matches, ocrSkippedCount });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      patch(eid, { ocrLoading: false });
    }
  };

  // Step 2 — send the matched (and new) OCR files to the recheck route, which
  // patches the server-side report (perlu_ocr→selesai, new docs appended).
  // Streamed (SSE), same reader shape as streamExtract, so per-file progress
  // is visible instead of one blocking call with no feedback until it resolves
  // or dies — the prior single-JSON version surfaced a mid-run timeout as an
  // opaque "Gagal mengekstrak hasil OCR" with no indication how far it got.
  const extractOcrResults = async (eid: string) => {
    const matches = runs[eid]?.ocrMatches;
    if (!matches || matches.length === 0) return;
    patch(eid, { ocrExtracting: true });
    try {
      appendLog(eid, `— Ekstraksi hasil OCR (${matches.length} dokumen) —`);
      const res = await fetch("/api/dd/recheck-ocr", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid, files: matches }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Gagal memulai ekstraksi OCR");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let successCount = 0;
      let sawComplete = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const ev of events) {
          const line = ev.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const msg = JSON.parse(line.slice(6));
          if (msg.type === "done") { appendLog(eid, `✓ ${msg.name}${msg.charCount ? ` (${msg.charCount} kar)` : ""}`); successCount++; }
          if (msg.type === "error") appendLog(eid, `✗ ${msg.name}: ${msg.reason}`);
          if (msg.type === "ocr_required") appendLog(eid, `✗ ${msg.name}: hasil OCR masih tanpa teks`);
          if (msg.type === "complete") sawComplete = true;
          if (msg.error) throw new Error(msg.error);
        }
      }
      if (!sawComplete) {
        throw new Error(
          "Ekstraksi OCR terputus sebelum selesai — dokumen yang sudah selesai tetap tersimpan; ulangi untuk sisanya."
        );
      }
      patch(eid, { ocrMatches: null });
      await refreshReport(eid);
      // An OCR recheck that actually adds text changes the entity's extracted
      // content the same way a retry does — invalidate the downstream stages.
      if (successCount > 0) {
        dispatch({
          type: "MARK_PROGRESS", entityId: eid,
          patch: { extracted: true, classified: false, tabled: false, analyzed: false },
        });
        appendLog(eid, STALE_DOWNSTREAM_NOTICE);
      }
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      patch(eid, { ocrExtracting: false });
    }
  };

  // Informed gate: never hand off to Stage 3 with partial coverage silently —
  // fetch any missing reports, then confirm when documents are still missing.
  const continueToClassify = async () => {
    let missing = 0;
    let gagalCount = 0;
    let ocrCount = 0;
    for (const e of t.entities) {
      let report = runs[e.id]?.report ?? null;
      if (!report) report = await refreshReport(e.id);
      if (!report) continue;
      missing += Math.max(0, report.files.length - report.processed);
      for (const f of report.files) {
        if (f.status === "gagal") gagalCount++;
        else if (f.status === "perlu_ocr") ocrCount++;
      }
    }
    if (missing > 0) {
      const ok = window.confirm(
        `${missing} dokumen belum terekstrak (${gagalCount} gagal, ${ocrCount} perlu OCR). Lanjutkan dengan cakupan sebagian?`
      );
      if (!ok) return;
    }
    dispatch({ type: "SET_STAGE", stage: 3 });
  };

  const allDone = t.entities.every((e) => state.progress[e.id]?.extracted);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1>2 — Ekstraksi Data Room</h1>
      {t.entities.map((e) => {
        const run = runs[e.id];
        const report = run?.report ?? null;
        const gagalCount = report ? report.files.filter((f) => f.status === "gagal").length : 0;
        const perluOcrCount = report ? report.files.filter((f) => f.status === "perlu_ocr").length : 0;
        const busy = !!(run?.running || run?.retrying || run?.ocrLoading || run?.ocrExtracting);
        const matches = run?.ocrMatches ?? null;
        const matchedCount = matches ? matches.filter((m) => m.replacesName).length : 0;
        const newCount = matches ? matches.length - matchedCount : 0;
        return (
          <div key={e.id} style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong>{e.name}</strong>
              <div style={{ display: "flex", gap: 8 }}>
                {gagalCount > 0 && (
                  <button onClick={() => retryFailed(e.id)} disabled={busy}>
                    {run?.retrying ? "Mengulang…" : `Coba ulang yang gagal (${gagalCount})`}
                  </button>
                )}
                <button onClick={() => extractEntity(e.id)} disabled={busy}>
                  {run?.running ? "Mengekstrak…" : state.progress[e.id]?.extracted ? "Ekstrak ulang" : "Mulai ekstraksi"}
                </button>
              </div>
            </div>
            {run?.log && run.log.length > 0 && (
              <pre style={{ maxHeight: 160, overflowY: "auto", fontSize: 12, background: "var(--bg-sidebar)", padding: 8 }}>{run.log.join("\n")}</pre>
            )}
            <DDCoveragePanel report={report} />
            {perluOcrCount > 0 && (
              <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 600 }}>Dokumen pindaian ({perluOcrCount}) — perlu OCR eksternal</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Jalankan OCR pada dokumen berstatus &ldquo;perlu OCR&rdquo; (mis. Adobe Acrobat → Recognize Text),
                  simpan hasilnya di satu folder SharePoint, lalu baca folder tersebut di sini.
                  Nama file boleh sama persis atau dengan sufiks _OCR.
                </div>
                <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Folder hasil OCR di SharePoint (path atau link)
                </label>
                <input
                  type="text"
                  value={run?.ocrFolder ?? ""}
                  onChange={(ev) => patch(e.id, { ocrFolder: ev.target.value, ocrMatches: null, ocrSkippedCount: 0 })}
                  placeholder="https://sandiva.sharepoint.com/… atau /sites/…/OCR"
                  disabled={busy}
                  style={{ fontFamily: "monospace", fontSize: 12, padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-color)", background: "var(--bg-surface)", color: "var(--text-primary)" }}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button onClick={() => readOcrFolder(e.id)} disabled={busy || !(run?.ocrFolder ?? "").trim()}>
                    {run?.ocrLoading ? "Membaca…" : "Baca folder OCR"}
                  </button>
                  {matches && (
                    <span style={{ fontSize: 13 }}>
                      Cocok: {matchedCount} · Baru: {newCount}
                      {(run?.ocrSkippedCount ?? 0) > 0 ? ` · sudah diimpor — dilewati (${run?.ocrSkippedCount})` : ""}
                    </span>
                  )}
                </div>
                {matches && matches.length > 0 && (
                  <>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
                      {matches.map((m, i) => (
                        <li key={i}>{m.name}{m.replacesName ? ` → menggantikan ${m.replacesName}` : " → dokumen baru"}</li>
                      ))}
                    </ul>
                    <button onClick={() => extractOcrResults(e.id)} disabled={busy} style={{ justifySelf: "start" }}>
                      {run?.ocrExtracting ? "Mengekstrak…" : `Ekstrak hasil OCR (${matches.length})`}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      <button onClick={continueToClassify} disabled={!allDone} style={{ padding: 12, fontWeight: 600 }}>
        Lanjut ke Klasifikasi →
      </button>
    </div>
  );
}
