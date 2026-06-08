"use client";

import { useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { CaseAnalysis } from "@/types";

const SECTION_LABELS: { key: keyof CaseAnalysis; label: string }[] = [
  { key: "identitasPihak", label: "Identitas Para Pihak" },
  { key: "hubunganHukum", label: "Hubungan Hukum Para Pihak" },
  { key: "kronologi", label: "Kronologi Fakta Material" },
  { key: "elemenHukum", label: "Elemen Hukum yang Dianalisis" },
  { key: "analisisElemen", label: "Analisis Elemen per Elemen" },
  { key: "buktiKunci", label: "Dokumen / Bukti Kunci" },
  { key: "kelemahanGaps", label: "Kelemahan dan Gaps" },
  { key: "posisiHukum", label: "Posisi Hukum yang Direkomendasikan" },
];

interface SkippedFile {
  name: string;
  reason: string;
}

interface ExtractProgress {
  current: number;
  total: number;
  name: string;
  skipped: SkippedFile[];
}

export default function Stage3Analysis() {
  const { state, dispatch, goToStage } = useWorkflow();
  const [phase, setPhase] = useState<"idle" | "extracting" | "analyzing" | "done">(
    state.caseAnalysis ? "done" : "idle"
  );
  const [extractProgress, setExtractProgress] = useState<ExtractProgress>({
    current: 0,
    total: state.selectedFiles.length,
    name: "",
    skipped: [],
  });
  const [error, setError] = useState("");
  const [editedAnalysis, setEditedAnalysis] = useState<CaseAnalysis | null>(state.caseAnalysis);

  async function runExtractAndAnalyze() {
    setPhase("extracting");
    setError("");
    setExtractProgress({ current: 0, total: state.selectedFiles.length, name: "", skipped: [] });

    try {
      // ── Step 1: SSE file extraction → stored in Blob by sessionId ──────────
      const res = await fetch("/api/sharepoint/read-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: state.selectedFiles, sessionId: state.sessionId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Gagal mengekstrak dokumen");
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      outer: while (true) {
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
            const event = JSON.parse(jsonStr) as Record<string, unknown>;
            if (typeof event.progress === "number") {
              setExtractProgress((p) => ({
                ...p,
                current: event.progress as number,
                total: event.total as number,
                name: (event.name as string) ?? "",
              }));
            } else if (event.skipped) {
              setExtractProgress((p) => ({
                ...p,
                skipped: [
                  ...p.skipped,
                  { name: event.skipped as string, reason: (event.reason as string) ?? "" },
                ],
              }));
            } else if (event.error) {
              throw new Error(event.error as string);
            } else if (event.done) {
              break outer;
            }
          } catch (parseErr) {
            // If it was our thrown Error, rethrow it
            if (parseErr instanceof Error && parseErr.message !== "Unexpected token") {
              throw parseErr;
            }
          }
        }
      }

      // ── Step 2: Analyze using Blob-stored text ──────────────────────────────
      setPhase("analyzing");

      const analyzeRes = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          docTypeId: state.docTypeId,
          practiceAreaId: state.practiceAreaId,
          claimType: state.claimType,
        }),
      });
      const analyzeData = await analyzeRes.json();
      if (!analyzeRes.ok) throw new Error(analyzeData.error || "Gagal menganalisis perkara");

      dispatch({ type: "SET_CASE_ANALYSIS", analysis: analyzeData.analysis });
      setEditedAnalysis(analyzeData.analysis);
      setPhase("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
      setPhase("idle");
    }
  }

  function updateSection(key: keyof CaseAnalysis, value: string) {
    if (!editedAnalysis) return;
    const updated = { ...editedAnalysis, [key]: value };
    setEditedAnalysis(updated);
    dispatch({ type: "SET_CASE_ANALYSIS", analysis: updated });
  }

  function handleProceed() {
    if (editedAnalysis) dispatch({ type: "SET_CASE_ANALYSIS", analysis: editedAnalysis });
    goToStage(4);
  }

  const pct =
    extractProgress.total > 0
      ? Math.round((extractProgress.current / extractProgress.total) * 100)
      : 0;

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
        Analisis Perkara
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
        Aplikasi akan mengekstrak teks dari {state.selectedFiles.length} file dan menganalisis perkara.
      </p>

      {phase === "idle" && (
        <button
          onClick={runExtractAndAnalyze}
          style={{ padding: "12px 28px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer", marginBottom: 24 }}
        >
          Mulai Ekstraksi &amp; Analisis
        </button>
      )}

      {phase === "extracting" && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
            <span>
              Memproses file {extractProgress.current} dari {extractProgress.total}
              {extractProgress.name ? ` — ${extractProgress.name}` : ""}
            </span>
            <span>{pct}%</span>
          </div>
          <div style={{ height: 6, background: "var(--border-color)", borderRadius: 3, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background: "var(--accent-blue)",
                borderRadius: 3,
                transition: "width 0.3s ease",
              }}
            />
          </div>
          {extractProgress.skipped.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {extractProgress.skipped.map((s, i) => (
                <div key={i} style={{ fontSize: 12, color: "#e67e22" }}>
                  ⚠ {s.name} — {s.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {phase === "analyzing" && (
        <div style={{ padding: 24, background: "var(--bg-surface)", borderRadius: 4, border: "1px solid var(--border-color)", marginBottom: 24, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid var(--border-color)", borderTopColor: "var(--accent-blue)", animation: "spin 0.8s linear infinite" }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>Menganalisis perkara...</span>
        </div>
      )}

      {phase === "done" && extractProgress.skipped.length > 0 && (
        <div style={{ padding: "10px 14px", background: "rgba(230,126,34,0.08)", border: "1px solid rgba(230,126,34,0.3)", borderRadius: 4, fontSize: 12, marginBottom: 16 }}>
          <strong style={{ color: "#e67e22" }}>
            {extractProgress.skipped.length} file dilewati:
          </strong>
          {extractProgress.skipped.map((s, i) => (
            <div key={i} style={{ color: "var(--text-muted)", marginTop: 2 }}>
              • {s.name} — {s.reason}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ padding: 16, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 24 }}>
          {error}
          <button
            onClick={runExtractAndAnalyze}
            style={{ marginLeft: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}
          >
            Coba lagi
          </button>
        </div>
      )}

      {editedAnalysis && (
        <div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16, padding: "10px 14px", background: "rgba(91,155,213,0.06)", borderRadius: 4, border: "1px solid rgba(91,155,213,0.2)" }}>
            Tinjau dan koreksi hasil analisis jika diperlukan sebelum membuat draf.
          </div>
          {SECTION_LABELS.map(({ key, label }) => (
            <div key={key} style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--accent-gold)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
                {label}
              </label>
              <textarea
                value={editedAnalysis[key] || ""}
                onChange={(e) => updateSection(key, e.target.value)}
                rows={4}
                style={{ resize: "vertical", fontSize: 13, lineHeight: 1.6 }}
              />
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
        <button
          onClick={() => goToStage(2)}
          style={{ padding: "10px 20px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 14, cursor: "pointer" }}
        >
          ← Kembali
        </button>
        {editedAnalysis && (
          <button
            onClick={handleProceed}
            style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer" }}
          >
            Buat Draf →
          </button>
        )}
      </div>
    </div>
  );
}
