"use client";

import { useState, useRef, useEffect } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { FileEntry, DocMapEntry, DocCategory, DocDocumentType, CaseAnalysis, InterviewAnswer } from "@/types";

// ─── Constants ────────────────────────────────────────────────────────────────

type Substep = "2A" | "2B" | "2C" | "2D";

const CATEGORY_META: Record<DocCategory, { label: string; color: string; bg: string }> = {
  KRITIS:    { label: "KRITIS",    color: "#e74c3c", bg: "rgba(231,76,60,0.08)"   },
  PENDUKUNG: { label: "PENDUKUNG", color: "#e67e22", bg: "rgba(230,126,34,0.08)"  },
  REFERENSI: { label: "REFERENSI", color: "#8aa3bc", bg: "rgba(138,163,188,0.08)" },
};

const CATEGORY_CYCLE: DocCategory[] = ["KRITIS", "PENDUKUNG", "REFERENSI"];

const DOC_TYPE_LABELS: Record<DocDocumentType, string> = {
  perjanjian_kontrak: "Perjanjian/Kontrak",
  putusan_penetapan:  "Putusan/Penetapan",
  surat_menyurat:     "Surat Menyurat",
  bukti_transaksi:    "Bukti Transaksi",
  dokumen_korporasi:  "Dokumen Korporasi",
  tidak_dikenali:     "Tidak Dikenali",
};

const FILE_ICON: Record<string, string> = { docx: "📄", doc: "📄", pdf: "📋", txt: "📝" };

interface ExtractLogEntry {
  name: string;
  category: DocCategory;
  status: "memproses" | "selesai" | "gagal";
  charCount?: number;
  reason?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function fireAndForget(url: string, body: object) {
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Stage2Resume =
  | { type: "file_list"; files: FileEntry[]; timestamp: string }
  | { type: "categorization"; docMap: DocMapEntry[]; selectedFileIds: string[]; timestamp: string }
  | { type: "extraction_progress"; docMap: DocMapEntry[]; completedFiles: ExtractLogEntry[]; remainingFiles: FileEntry[]; processed: number; totalChars: number; timestamp: string };

type PriorSession = {
  latestTimestamp: string;
  analysis?: CaseAnalysis;
  kronologi?: string;
  interviewAnswers?: InterviewAnswer[];
  strategicAssessment?: string;
  resumeAtStage?: 3 | 4;
  resumeAtSubstep?: "3A" | "3B" | "3C";
  stage2Resume?: Stage2Resume;
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Stage2Files() {
  const { state, dispatch, goToStage } = useWorkflow();

  const initialSubstep: Substep = (() => {
    if (state.selectedFiles.length > 0 && state.docMap.length > 0) return "2B";
    return "2A";
  })();

  const [substep, setSubstep] = useState<Substep>(initialSubstep);
  const [folderLink, setFolderLink] = useState(state.folderPath || "");
  const [discovering, setDiscovering] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [error, setError] = useState("");

  // 2A: local checked state
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(
      state.allFiles.length > 0
        ? state.allFiles.map((f) => f.id)
        : []
    )
  );

  // 2B: local docMap with category edits
  const [localMap, setLocalMap] = useState<DocMapEntry[]>(state.docMap);
  const [b2CheckedIds, setB2CheckedIds] = useState<Set<string>>(
    () => new Set(state.docMap.map((e) => e.fileId))
  );

  // 2C: live extraction log
  const [extractLog, setExtractLog] = useState<ExtractLogEntry[]>([]);
  const [extractDone, setExtractDone] = useState(false);
  const [totalChars, setTotalChars] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [stoppedEarly, setStoppedEarly] = useState(false);

  // 2D: inventory collapse/expand + SharePoint save status
  const [inventoryExpanded, setInventoryExpanded] = useState(true);
  const [spSaveStatus, setSpSaveStatus] = useState<"idle" | "pending" | "saved" | "failed">("idle");
  const [spSaveUrl, setSpSaveUrl] = useState<string | null>(null);

  // Session continuity banner
  const [priorSession, setPriorSession] = useState<PriorSession | null>(null);
  const [priorSessionDismissed, setPriorSessionDismissed] = useState(false);

  // Refs for abort / stop
  const abortControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const saveProgressRef = useRef(false);

  // When arriving with folderPath already set (global resume), auto-check for
  // prior Stage 2 artifacts so the detailed resume banner appears without
  // re-entering the folder link.
  const hasAutoChecked = useRef(false);
  useEffect(() => {
    if (hasAutoChecked.current) return;
    hasAutoChecked.current = true;
    if (!state.folderPath || state.docMap.length > 0 || substep !== "2A") return;
    fetch("/api/sharepoint/check-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath: state.folderPath }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.found && data.stage2Resume) setPriorSession(data as PriorSession);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 2A: Load filenames only ─────────────────────────────────────────────────
  async function discoverFiles() {
    const link = folderLink.trim();
    if (!link) return;
    setDiscovering(true);
    setError("");
    try {
      const res = await fetch("/api/sharepoint/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: link }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Gagal memuat daftar file");
      if (!result.files?.length) throw new Error("Tidak ada dokumen (docx/pdf/doc/txt) ditemukan di folder ini.");
      dispatch({ type: "SET_FOLDER", folderPath: link });
      dispatch({ type: "SET_ALL_FILES", files: result.files });
      setCheckedIds(new Set((result.files as FileEntry[]).map((f) => f.id)));

      // Save file list to SharePoint AI folder
      fireAndForget("/api/sharepoint/save-matter-file", {
        folderPath: link,
        filename: `AI/file_list_${ts()}.json`,
        content: JSON.stringify({ files: result.files, timestamp: new Date().toISOString() }),
      });

      // Background session continuity check
      fetch("/api/sharepoint/check-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: link }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.found) setPriorSession(data as PriorSession);
        })
        .catch(() => {});
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setDiscovering(false);
    }
  }

  function toggleCheck2A(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAll2A() {
    setCheckedIds(new Set(state.allFiles.map((f) => f.id)));
  }

  function clearAll2A() {
    setCheckedIds(new Set());
  }

  // Confirm selection → trigger AI mapping
  async function confirmSelection() {
    const selected = state.allFiles.filter((f) => checkedIds.has(f.id));
    if (selected.length === 0) {
      setError("Pilih minimal satu dokumen untuk dilanjutkan.");
      return;
    }
    dispatch({ type: "SET_SELECTED_FILES", files: selected });
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setMapping(true);
    setError("");
    setSubstep("2B");
    try {
      const res = await fetch("/api/sharepoint/map-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: selected,
          docTypeId: state.docTypeId,
          claimType: state.claimType,
        }),
        signal: controller.signal,
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Gagal membuat peta dokumen");
      dispatch({ type: "SET_DOC_MAP", map: result.map });
      setLocalMap(result.map);
      setB2CheckedIds(new Set((result.map as DocMapEntry[]).map((e) => e.fileId)));
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        setSubstep("2A");
        setError("AI kategorisasi dihentikan. Coba lagi atau lanjutkan nanti.");
      } else {
        setError(e instanceof Error ? e.message : "Terjadi kesalahan");
        setSubstep("2A");
      }
    } finally {
      setMapping(false);
    }
  }

  // ── 2B: Drafter adjusts categories ──────────────────────────────────────────
  function toggleCheck2B(fileId: string) {
    setB2CheckedIds((prev) => {
      const next = new Set(prev);
      next.has(fileId) ? next.delete(fileId) : next.add(fileId);
      return next;
    });
  }

  // Confirm 2B → start extraction
  async function startExtraction() {
    const checkedEntries = localMap.filter((e) => b2CheckedIds.has(e.fileId));
    if (checkedEntries.length === 0) {
      setError("Pilih minimal satu dokumen untuk diekstrak.");
      return;
    }

    const filesById = new Map(state.selectedFiles.map((f) => [f.id, f]));
    const sorted = [...checkedEntries]
      .sort((a, b) => CATEGORY_CYCLE.indexOf(a.category) - CATEGORY_CYCLE.indexOf(b.category))
      .map((e) => filesById.get(e.fileId))
      .filter((f): f is FileEntry => !!f);

    dispatch({ type: "SET_DOC_MAP", map: localMap });

    // Save confirmed categorization to SharePoint before starting SSE
    if (state.folderPath) {
      fireAndForget("/api/sharepoint/save-matter-file", {
        folderPath: state.folderPath,
        filename: `AI/categorization_${ts()}.json`,
        content: JSON.stringify({
          docMap: localMap,
          selectedFileIds: sorted.map((f) => f.id),
          timestamp: new Date().toISOString(),
        }),
      });
    }

    setStoppedEarly(false);
    await runExtraction(sorted, localMap, [], 0, 0, 0);
  }

  // Resume extraction from saved progress
  async function startExtractionFromResume(
    remainingFiles: FileEntry[],
    savedDocMap: DocMapEntry[],
    priorLog: ExtractLogEntry[],
    priorProcessed: number,
    priorSkipped: number,
    priorTotalChars: number,
  ) {
    setLocalMap(savedDocMap);
    dispatch({ type: "SET_DOC_MAP", map: savedDocMap });
    setStoppedEarly(false);
    await runExtraction(remainingFiles, savedDocMap, priorLog, priorProcessed, priorSkipped, priorTotalChars);
  }

  // Core SSE extraction loop
  async function runExtraction(
    filesToExtract: FileEntry[],
    mapEntries: DocMapEntry[],
    prependLog: ExtractLogEntry[],
    priorProcessed: number,
    priorSkipped: number,
    priorTotalChars: number,
  ) {
    stopRequestedRef.current = false;
    saveProgressRef.current = false;

    const newEntries: ExtractLogEntry[] = filesToExtract.map((f) => {
      const entry = mapEntries.find((e) => e.fileId === f.id);
      return { name: f.name, category: entry?.category ?? "REFERENSI", status: "memproses" };
    });
    let localLog: ExtractLogEntry[] = [...prependLog, ...newEntries];
    setExtractLog(localLog);
    setExtractDone(false);
    let runTotalChars = priorTotalChars;
    let runProcessed = priorProcessed;
    let runSkipped = priorSkipped;
    setTotalChars(priorTotalChars);
    setProcessedCount(priorProcessed);
    setSkippedCount(priorSkipped);
    setError("");
    setSubstep("2C");

    try {
      const res = await fetch("/api/sharepoint/read-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: filesToExtract,
          docMap: mapEntries,
          sessionId: state.sessionId,
          folderPath: state.folderPath,
          docTypeId: state.docTypeId,
          practiceAreaId: state.practiceAreaId,
          claimType: state.claimType,
          ref: state.ref,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Gagal mengekstrak dokumen");
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let stopped = false;

      while (true) {
        if (stopped) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;
          try {
            const ev = JSON.parse(jsonStr) as Record<string, unknown>;
            if (ev.type === "done" || ev.type === "error") {
              const fileIdx = ev.index as number;
              const logIdx = fileIdx + prependLog.length;
              if (ev.type === "done") {
                localLog = localLog.map((entry, i) =>
                  i === logIdx ? { ...entry, status: "selesai", charCount: ev.charCount as number } : entry
                );
                runTotalChars += ev.charCount as number;
                runProcessed += 1;
                setTotalChars(runTotalChars);
                setProcessedCount(runProcessed);
              } else {
                localLog = localLog.map((entry, i) =>
                  i === logIdx ? { ...entry, status: "gagal", reason: ev.reason as string } : entry
                );
                runSkipped += 1;
                setSkippedCount(runSkipped);
              }
              setExtractLog([...localLog]);

              if (stopRequestedRef.current) {
                reader.cancel();
                stopped = true;
                if (saveProgressRef.current && state.folderPath) {
                  const remaining = filesToExtract.slice(fileIdx + 1);
                  fireAndForget("/api/sharepoint/save-matter-file", {
                    folderPath: state.folderPath,
                    filename: `AI/extraction_progress_${ts()}.json`,
                    content: JSON.stringify({
                      sessionId: state.sessionId,
                      docMap: mapEntries,
                      completedFiles: localLog.filter((e) => e.status !== "memproses"),
                      remainingFiles: remaining,
                      processed: runProcessed,
                      totalChars: runTotalChars,
                      timestamp: new Date().toISOString(),
                    }),
                  });
                }
                setStoppedEarly(true);
                setSubstep("2D");
                break;
              }
            } else if (ev.type === "complete") {
              setExtractDone(true);
              setSubstep("2D");
              setSpSaveStatus("pending");
              fetch("/api/docx/inventory-save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: state.sessionId, folderPath: state.folderPath }),
              })
                .then((r) => r.json())
                .then((data) => {
                  if (data.webUrl) { setSpSaveUrl(data.webUrl); setSpSaveStatus("saved"); }
                  else setSpSaveStatus("failed");
                })
                .catch(() => setSpSaveStatus("failed"));
            } else if (ev.error) {
              throw new Error(ev.error as string);
            }
          } catch (inner) {
            if (inner instanceof Error && inner.message !== "Unexpected token") throw inner;
          }
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan saat ekstraksi");
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const b2SelectedCount = b2CheckedIds.size;
  const fileById = (id: string) => state.selectedFiles.find((f) => f.id === id) ?? state.allFiles.find((f) => f.id === id);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
          Dokumen Perkara
        </h1>
        <SubstepBadge current={substep} />
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* ── 2A: File Discovery + Selection ────────────────────────────────────── */}
      {substep === "2A" && (
        <div>
          <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 20 }}>
            Masukkan sharing link folder SharePoint yang berisi dokumen perkara.
          </p>
          <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
            <input
              type="text"
              value={folderLink}
              onChange={(e) => { setFolderLink(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && discoverFiles()}
              placeholder="https://sandiva.sharepoint.com/:f:/s/SiteName/AbCdEfGhIj..."
              style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }}
              disabled={discovering}
            />
            <button
              onClick={discoverFiles}
              disabled={discovering || !folderLink.trim()}
              style={{ padding: "8px 20px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", opacity: discovering || !folderLink.trim() ? 0.6 : 1 }}
            >
              {discovering ? "Memuat..." : "Muat Daftar"}
            </button>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 20 }}>
            Buka folder di SharePoint → klik <strong>Bagikan</strong> → salin link → tempel di sini.
          </p>

          {/* Stage 3 session continuity banner */}
          {priorSession && !priorSessionDismissed && priorSession.analysis && (
            <div style={{ padding: "12px 16px", background: "rgba(91,155,213,0.08)", border: "1px solid rgba(91,155,213,0.35)", borderRadius: 4, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, color: "var(--text-primary)" }}>
                ⟳ Ditemukan sesi sebelumnya dari{" "}
                <strong>{new Date(priorSession.latestTimestamp).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</strong>.
                Lanjutkan dari Tahap 3?
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => {
                    if (priorSession.analysis) dispatch({ type: "SET_CASE_ANALYSIS", analysis: priorSession.analysis });
                    if (priorSession.interviewAnswers) dispatch({ type: "SET_INTERVIEW_ANSWERS", answers: priorSession.interviewAnswers });
                    if (priorSession.strategicAssessment) dispatch({ type: "SET_STRATEGIC_ASSESSMENT", text: priorSession.strategicAssessment });
                    goToStage(priorSession.resumeAtStage ?? 3);
                  }}
                  style={{ padding: "6px 14px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 3, fontSize: 12, fontWeight: 500, cursor: "pointer" }}
                >
                  Ya, Lanjutkan
                </button>
                <button
                  onClick={() => setPriorSessionDismissed(true)}
                  style={{ padding: "6px 14px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 3, color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
                >
                  Tidak, Mulai Baru
                </button>
              </div>
            </div>
          )}

          {/* Stage 2 session resume banner (shown only when no Stage 3 analysis) */}
          {priorSession && !priorSessionDismissed && !priorSession.analysis && priorSession.stage2Resume && (
            <Stage2ResumeBanner
              resume={priorSession.stage2Resume}
              onDismiss={() => setPriorSessionDismissed(true)}
              onResumeFileList={(files) => {
                dispatch({ type: "SET_ALL_FILES", files });
                setCheckedIds(new Set(files.map((f) => f.id)));
                setPriorSessionDismissed(true);
              }}
              onResumeCategorization={(docMap, selectedFileIds) => {
                const byId = new Map(state.allFiles.map((f) => [f.id, f]));
                const selected = selectedFileIds.map((id) => byId.get(id)).filter((f): f is FileEntry => !!f);
                dispatch({ type: "SET_SELECTED_FILES", files: selected });
                dispatch({ type: "SET_DOC_MAP", map: docMap });
                setLocalMap(docMap);
                setB2CheckedIds(new Set(selectedFileIds));
                setSubstep("2B");
                setPriorSessionDismissed(true);
              }}
              onResumeExtractionProgress={(resume) => {
                const completedLog = resume.completedFiles;
                dispatch({ type: "SET_DOC_MAP", map: resume.docMap });
                setExtractLog(completedLog);
                setProcessedCount(resume.processed);
                setTotalChars(resume.totalChars);
                setSkippedCount(completedLog.filter((e) => e.status === "gagal").length);
                setStoppedEarly(true);
                setSubstep("2D");
                setPriorSessionDismissed(true);
              }}
              onContinueExtraction={(resume) => {
                setPriorSessionDismissed(true);
                startExtractionFromResume(
                  resume.remainingFiles,
                  resume.docMap,
                  resume.completedFiles,
                  resume.processed,
                  resume.completedFiles.filter((e) => e.status === "gagal").length,
                  resume.totalChars,
                );
              }}
            />
          )}

          {state.allFiles.length > 0 && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: checkedIds.size === 0 ? "var(--error)" : "var(--text-muted)" }}>
                  {checkedIds.size} dari {state.allFiles.length} file dipilih
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={selectAll2A} style={{ fontSize: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer" }}>Pilih Semua</button>
                  <button onClick={clearAll2A} style={{ fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>Batalkan Semua</button>
                </div>
              </div>
              <div style={{ border: "1px solid var(--border-color)", borderRadius: 4, maxHeight: 300, overflowY: "auto", marginBottom: 12 }}>
                {state.allFiles.map((f, i) => {
                  const checked = checkedIds.has(f.id);
                  return (
                    <div
                      key={f.id}
                      onClick={() => toggleCheck2A(f.id)}
                      style={{
                        display: "flex", gap: 10, padding: "9px 12px",
                        borderBottom: i < state.allFiles.length - 1 ? "1px solid var(--border-color)" : "none",
                        alignItems: "center", cursor: "pointer",
                        background: checked ? "rgba(91,155,213,0.05)" : "transparent",
                        opacity: checked ? 1 : 0.45,
                        userSelect: "none",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {}}
                        style={{ flexShrink: 0, pointerEvents: "none" }}
                      />
                      <span style={{ fontSize: 14, flexShrink: 0 }}>{FILE_ICON[f.type] || "📎"}</span>
                      <span style={{
                        flex: 1, fontSize: 13,
                        color: checked ? "var(--text-primary)" : "var(--text-muted)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        textDecoration: checked ? "none" : "line-through",
                      }}>
                        {f.name}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{f.size}</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", flexShrink: 0 }}>{f.type}</span>
                    </div>
                  );
                })}
              </div>
              {checkedIds.size === 0 && (
                <p style={{ fontSize: 13, color: "var(--error)", marginBottom: 12 }}>
                  Pilih minimal satu file untuk melanjutkan.
                </p>
              )}
              <button
                onClick={confirmSelection}
                disabled={checkedIds.size === 0}
                style={{ padding: "10px 24px", background: checkedIds.size > 0 ? "var(--accent-blue)" : "var(--border-color)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: checkedIds.size > 0 ? "pointer" : "not-allowed" }}
              >
                Konfirmasi Pilihan File ({checkedIds.size}) →
              </button>
            </>
          )}

          <div style={{ marginTop: 24 }}>
            <button
              onClick={() => goToStage(1)}
              style={{ padding: "10px 20px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 14, cursor: "pointer" }}
            >
              ← Kembali ke Pilihan Dokumen
            </button>
          </div>
        </div>
      )}

      {/* ── 2B: AI Document Map ───────────────────────────────────────────────── */}
      {substep === "2B" && (
        <div>
          {mapping ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 20, background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 4 }}>
              <Spinner />
              <span style={{ fontSize: 14, color: "var(--text-muted)", flex: 1 }}>
                AI sedang mengategorikan {state.selectedFiles.length} file...
              </span>
              <button
                onClick={() => abortControllerRef.current?.abort()}
                style={{ padding: "5px 14px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 3, color: "var(--text-muted)", fontSize: 12, cursor: "pointer", flexShrink: 0 }}
              >
                Hentikan
              </button>
            </div>
          ) : (
            <>
              <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 6 }}>
                AI telah mengkategorikan {state.selectedFiles.length} file. Tinjau, ubah kategori atau centang jika diperlukan, lalu konfirmasi.
              </p>
              <div style={{ display: "flex", gap: 16, marginBottom: 20, fontSize: 12, flexWrap: "wrap" }}>
                {CATEGORY_CYCLE.map((cat) => {
                  const count = localMap.filter((e) => e.category === cat).length;
                  return (
                    <span key={cat} style={{ color: CATEGORY_META[cat].color, fontWeight: 600 }}>
                      {CATEGORY_META[cat].label} {count}
                    </span>
                  );
                })}
                <span style={{ color: "var(--text-muted)", marginLeft: "auto" }}>{b2SelectedCount} akan diekstrak</span>
              </div>

              {CATEGORY_CYCLE.map((cat) => {
                const entries = localMap.filter((e) => e.category === cat);
                if (entries.length === 0) return null;
                const meta = CATEGORY_META[cat];
                return (
                  <div key={cat} style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 11, letterSpacing: "0.1em", fontWeight: 700, color: meta.color, marginBottom: 8 }}>
                      {meta.label} — {entries.length} file
                    </div>
                    <div style={{ border: `1px solid ${meta.color}33`, borderRadius: 4, overflow: "hidden" }}>
                      {entries.map((entry, i) => {
                        const file = fileById(entry.fileId);
                        if (!file) return null;
                        return (
                          <MapRow
                            key={entry.fileId}
                            file={file}
                            entry={entry}
                            isLast={i === entries.length - 1}
                            checked={b2CheckedIds.has(entry.fileId)}
                            onToggle={() => toggleCheck2B(entry.fileId)}
                            onCategoryChange={(cat) => setLocalMap((m) => m.map((e) => e.fileId === entry.fileId ? { ...e, category: cat } : e))}
                            meta={meta}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              <div style={{ display: "flex", gap: 12 }}>
                <button
                  onClick={() => setSubstep("2A")}
                  style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}
                >
                  ← Ubah Pilihan File
                </button>
                <button
                  onClick={startExtraction}
                  disabled={b2SelectedCount === 0}
                  style={{ padding: "10px 24px", background: b2SelectedCount > 0 ? "var(--accent-blue)" : "var(--border-color)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: b2SelectedCount > 0 ? "pointer" : "not-allowed" }}
                >
                  Konfirmasi &amp; Ekstrak ({b2SelectedCount} file) →
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── 2C: Extraction Progress ───────────────────────────────────────────── */}
      {substep === "2C" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
            <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
              Mengekstrak konten dokumen. File KRITIS diproses terlebih dahulu.
            </p>
            {!extractDone && (
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => { stopRequestedRef.current = true; }}
                  style={{ padding: "6px 14px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 3, color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
                >
                  Hentikan Ekstraksi
                </button>
                <button
                  onClick={() => { stopRequestedRef.current = true; saveProgressRef.current = true; }}
                  style={{ padding: "6px 14px", background: "transparent", border: "1px solid var(--accent-gold)", borderRadius: 3, color: "var(--accent-gold)", fontSize: 12, cursor: "pointer" }}
                >
                  Lanjutkan Nanti
                </button>
              </div>
            )}
          </div>
          <div style={{ border: "1px solid var(--border-color)", borderRadius: 4, overflow: "hidden", marginBottom: 20 }}>
            {extractLog.map((entry, i) => {
              const meta = CATEGORY_META[entry.category];
              return (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: i < extractLog.length - 1 ? "1px solid var(--border-color)" : "none", background: entry.status === "gagal" ? "rgba(192,57,43,0.04)" : entry.status === "selesai" ? "rgba(39,174,96,0.04)" : "transparent" }}
                >
                  <span style={{ fontSize: 13, width: 20, textAlign: "center", flexShrink: 0 }}>
                    {entry.status === "selesai" ? "✓" : entry.status === "gagal" ? "✗" : <SpinnerInline />}
                  </span>
                  <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, letterSpacing: "0.05em", flexShrink: 0 }}>{meta.label}</span>
                  {entry.status === "selesai" && entry.charCount !== undefined && (
                    <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{(entry.charCount / 1000).toFixed(1)}k chars</span>
                  )}
                  {entry.status === "gagal" && entry.reason && (
                    <span style={{ fontSize: 11, color: "var(--error)", flexShrink: 0 }} title={entry.reason}>gagal</span>
                  )}
                </div>
              );
            })}
          </div>
          {error && (
            <div style={{ fontSize: 13, color: "var(--error)", marginBottom: 16 }}>
              {error}
            </div>
          )}
        </div>
      )}

      {/* ── 2D: Completion Summary ────────────────────────────────────────────── */}
      {substep === "2D" && (
        <div>
          {stoppedEarly ? (
            <div style={{ padding: "14px 18px", background: "rgba(230,126,34,0.08)", border: "1px solid var(--accent-gold)", borderRadius: 4, fontSize: 14, color: "var(--accent-gold)", marginBottom: 20, fontWeight: 500 }}>
              ⏸ Ekstraksi dihentikan — draf akan dibuat dari dokumen yang sudah diekstrak.
            </div>
          ) : (
            <div style={{ padding: "14px 18px", background: "rgba(39,174,96,0.08)", border: "1px solid var(--success)", borderRadius: 4, fontSize: 14, color: "var(--success)", marginBottom: 20, fontWeight: 500 }}>
              ✓ Ekstraksi selesai
            </div>
          )}

          <div style={{ display: "flex", gap: 24, marginBottom: 20, flexWrap: "wrap" }}>
            <Stat label="File diproses" value={processedCount} />
            <Stat label="File gagal" value={skippedCount} />
            <Stat label="Total karakter" value={`${(totalChars / 1000).toFixed(1)}k`} />
          </div>

          {/* SharePoint save status */}
          {!stoppedEarly && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
              {spSaveStatus === "pending" && "Menyimpan inventaris ke SharePoint..."}
              {spSaveStatus === "saved" && spSaveUrl && (
                <a href={spSaveUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--success)", textDecoration: "none" }}>
                  ✓ Inventaris tersimpan di SharePoint
                </a>
              )}
              {spSaveStatus === "saved" && !spSaveUrl && "✓ Inventaris tersimpan di SharePoint"}
              {spSaveStatus === "failed" && <span style={{ color: "var(--text-muted)" }}>Gagal disimpan ke SharePoint</span>}
            </div>
          )}

          {/* Inventory toggle + table */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {CATEGORY_CYCLE.map((cat) => {
                const count = extractLog.filter((e) => e.category === cat && e.status === "selesai").length;
                if (count === 0) return null;
                const meta = CATEGORY_META[cat];
                return (
                  <span key={cat} style={{ fontSize: 12, padding: "4px 10px", background: meta.bg, color: meta.color, borderRadius: 3, fontWeight: 600, border: `1px solid ${meta.color}33` }}>
                    {meta.label} {count}
                  </span>
                );
              })}
            </div>
            <button
              onClick={() => setInventoryExpanded((v) => !v)}
              style={{ fontSize: 12, color: "var(--text-muted)", background: "none", border: "1px solid var(--border-color)", borderRadius: 3, padding: "3px 10px", cursor: "pointer" }}
            >
              {inventoryExpanded ? "▲ Sembunyikan" : "▼ Tampilkan"} Inventaris
            </button>
          </div>

          {inventoryExpanded && (
            <div style={{ border: "1px solid var(--border-color)", borderRadius: 4, overflow: "hidden", marginBottom: 20 }}>
              {extractLog.map((entry, i) => {
                const meta = CATEGORY_META[entry.category];
                return (
                  <div
                    key={i}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: i < extractLog.length - 1 ? "1px solid var(--border-color)" : "none", background: entry.status === "gagal" ? "rgba(192,57,43,0.04)" : entry.status === "selesai" ? "rgba(39,174,96,0.02)" : "transparent" }}
                  >
                    <span style={{ fontSize: 13, width: 16, textAlign: "center", flexShrink: 0, color: entry.status === "selesai" ? "var(--success)" : entry.status === "gagal" ? "var(--error)" : "var(--text-muted)" }}>
                      {entry.status === "selesai" ? "✓" : entry.status === "gagal" ? "✗" : "·"}
                    </span>
                    <span style={{ flex: 1, fontSize: 12, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, letterSpacing: "0.05em", flexShrink: 0 }}>{meta.label}</span>
                    {entry.status === "selesai" && entry.charCount !== undefined && (
                      <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0, minWidth: 50, textAlign: "right" }}>{(entry.charCount / 1000).toFixed(1)}k</span>
                    )}
                    {entry.status === "gagal" && entry.reason && (
                      <span style={{ fontSize: 11, color: "var(--error)", flexShrink: 0 }} title={entry.reason}>gagal</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Failed files summary */}
          {skippedCount > 0 && (
            <div style={{ padding: "10px 14px", background: "rgba(192,57,43,0.06)", border: "1px solid rgba(192,57,43,0.2)", borderRadius: 4, fontSize: 12, marginBottom: 20 }}>
              <strong style={{ color: "var(--error)" }}>{skippedCount} file gagal diekstrak:</strong>
              {extractLog.filter((e) => e.status === "gagal").map((e, i) => (
                <div key={i} style={{ color: "var(--text-muted)", marginTop: 4 }}>• {e.name}{e.reason ? ` — ${e.reason}` : ""}</div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button
              onClick={() => setSubstep("2B")}
              style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}
            >
              ← Ulang Pilihan
            </button>
            {!stoppedEarly && (
              <a
                href={`/api/docx/inventory?sessionId=${state.sessionId}`}
                download
                style={{ padding: "10px 18px", background: "transparent", border: "1px solid var(--accent-gold)", borderRadius: 4, color: "var(--accent-gold)", fontSize: 13, fontWeight: 500, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                ↓ Unduh Inventaris PDF
              </a>
            )}
            <button
              onClick={() => goToStage(3)}
              style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer" }}
            >
              Lanjut ke Kronologi →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Stage 2 Resume Banner ────────────────────────────────────────────────────

type ExtractionProgressResume = {
  type: "extraction_progress";
  docMap: DocMapEntry[];
  completedFiles: ExtractLogEntry[];
  remainingFiles: FileEntry[];
  processed: number;
  totalChars: number;
  timestamp: string;
};

function Stage2ResumeBanner({
  resume,
  onDismiss,
  onResumeFileList,
  onResumeCategorization,
  onResumeExtractionProgress,
  onContinueExtraction,
}: {
  resume: Stage2Resume;
  onDismiss: () => void;
  onResumeFileList: (files: FileEntry[]) => void;
  onResumeCategorization: (docMap: DocMapEntry[], selectedFileIds: string[]) => void;
  onResumeExtractionProgress: (resume: ExtractionProgressResume) => void;
  onContinueExtraction: (resume: ExtractionProgressResume) => void;
}) {
  const dateStr = new Date(resume.timestamp).toLocaleString("id-ID", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const bannerStyle: React.CSSProperties = {
    padding: "12px 16px",
    background: "rgba(91,155,213,0.08)",
    border: "1px solid rgba(91,155,213,0.35)",
    borderRadius: 4,
    marginBottom: 16,
  };

  const btnPrimary: React.CSSProperties = {
    padding: "6px 14px", background: "var(--accent-blue)", color: "white",
    border: "none", borderRadius: 3, fontSize: 12, fontWeight: 500, cursor: "pointer",
  };
  const btnSecondary: React.CSSProperties = {
    padding: "6px 14px", background: "transparent", border: "1px solid var(--border-color)",
    borderRadius: 3, color: "var(--text-muted)", fontSize: 12, cursor: "pointer",
  };

  if (resume.type === "file_list") {
    return (
      <div style={bannerStyle}>
        <div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 10 }}>
          ⟳ Ditemukan daftar file dari <strong>{dateStr}</strong> ({resume.files.length} file).
          Muat ulang folder tidak diperlukan.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={btnPrimary} onClick={() => onResumeFileList(resume.files)}>Lanjutkan</button>
          <button style={btnSecondary} onClick={onDismiss}>Mulai Baru</button>
        </div>
      </div>
    );
  }

  if (resume.type === "categorization") {
    return (
      <div style={bannerStyle}>
        <div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 10 }}>
          ⟳ Ditemukan kategorisasi dari <strong>{dateStr}</strong>.{" "}
          {resume.selectedFileIds.length} file siap diekstrak.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={btnPrimary} onClick={() => onResumeCategorization(resume.docMap, resume.selectedFileIds)}>Langsung Ekstrak</button>
          <button style={btnSecondary} onClick={onDismiss}>Mulai Baru</button>
        </div>
      </div>
    );
  }

  // extraction_progress
  const ep = resume as ExtractionProgressResume;
  const completedCount = ep.completedFiles.filter((e) => e.status === "selesai").length;
  const totalCount = completedCount + ep.remainingFiles.length;
  return (
    <div style={bannerStyle}>
      <div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 10 }}>
        ⟳ Ekstraksi sebelumnya dihentikan dari <strong>{dateStr}</strong>:{" "}
        <strong>{completedCount}/{totalCount}</strong> file selesai.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button style={btnPrimary} onClick={() => onResumeExtractionProgress(ep)}>
          Lanjut dengan Dokumen yang Ada
        </button>
        {ep.remainingFiles.length > 0 && (
          <button style={{ ...btnPrimary, background: "var(--accent-gold)" }} onClick={() => onContinueExtraction(ep)}>
            Lanjutkan Ekstraksi ({ep.remainingFiles.length} sisa)
          </button>
        )}
        <button style={btnSecondary} onClick={onDismiss}>Mulai Baru</button>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SubstepBadge({ current }: { current: Substep }) {
  const steps: { id: Substep; label: string }[] = [
    { id: "2A", label: "Pilih" },
    { id: "2B", label: "Kategorikan" },
    { id: "2C", label: "Ekstrak" },
    { id: "2D", label: "Selesai" },
  ];
  const order = ["2A", "2B", "2C", "2D"];
  const currentIdx = order.indexOf(current);
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const active = s.id === current;
        return (
          <span
            key={s.id}
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 10,
              fontWeight: active ? 600 : 400,
              background: done ? "var(--accent-blue)" : active ? "rgba(91,155,213,0.15)" : "transparent",
              color: done ? "white" : active ? "var(--accent-blue)" : "var(--text-muted)",
              border: active ? "1px solid var(--accent-blue)" : "1px solid transparent",
            }}
          >
            {done ? "✓" : s.id} {s.label}
          </span>
        );
      })}
    </div>
  );
}

function MapRow({
  file,
  entry,
  isLast,
  checked,
  onToggle,
  onCategoryChange,
  meta,
}: {
  file: FileEntry;
  entry: DocMapEntry;
  isLast: boolean;
  checked: boolean;
  onToggle: () => void;
  onCategoryChange: (cat: DocCategory) => void;
  meta: { color: string; bg: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const catMeta = CATEGORY_META[entry.category];

  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--border-color)", background: checked ? meta.bg : "transparent" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer" }} onClick={onToggle}>
        <input type="checkbox" checked={checked} onChange={onToggle} onClick={(e) => e.stopPropagation()} />
        <span style={{ fontSize: 14 }}>{FILE_ICON[file.type] || "📎"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file.name}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {DOC_TYPE_LABELS[entry.documentType]} · {file.size || "—"}
          </div>
        </div>
        <select
          value={entry.category}
          onChange={(e) => { e.stopPropagation(); onCategoryChange(e.target.value as DocCategory); }}
          onClick={(e) => e.stopPropagation()}
          style={{ fontSize: 11, fontWeight: 700, color: catMeta.color, background: catMeta.bg, border: `1px solid ${catMeta.color}55`, borderRadius: 3, padding: "2px 6px", cursor: "pointer", flexShrink: 0, appearance: "none", WebkitAppearance: "none" }}
        >
          {CATEGORY_CYCLE.map((cat) => (
            <option key={cat} value={cat} style={{ color: CATEGORY_META[cat].color, background: "var(--bg-surface, #1e2a3a)", fontWeight: 700 }}>
              {cat}
            </option>
          ))}
        </select>
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
          title="Lihat alasan AI"
        >
          {expanded ? "▲" : "▼"}
        </button>
      </div>
      {expanded && (
        <div style={{ padding: "0 14px 10px 46px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", lineHeight: 1.5 }}>
          {entry.reasoning}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <>
      <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--border-color)", borderTopColor: "var(--accent-blue)", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}

function SpinnerInline() {
  return (
    <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", border: "2px solid var(--border-color)", borderTopColor: "var(--accent-blue)", animation: "spin 0.8s linear infinite" }} />
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)" }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}
