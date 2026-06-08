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

export default function Stage3Analysis() {
  const { state, dispatch, goToStage } = useWorkflow();
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [editedAnalysis, setEditedAnalysis] = useState<CaseAnalysis | null>(state.caseAnalysis);

  async function runAnalysis() {
    setAnalyzing(true);
    setError("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          docTypeId: state.docTypeId,
          practiceAreaId: state.practiceAreaId,
          claimType: state.claimType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menganalisis perkara");
      dispatch({ type: "SET_CASE_ANALYSIS", analysis: data.analysis });
      setEditedAnalysis(data.analysis);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setAnalyzing(false);
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

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
        Analisis Perkara
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
        Claude akan menganalisis {state.selectedFiles.length} dokumen yang telah diekstrak.
      </p>

      {!editedAnalysis && !analyzing && (
        <button
          onClick={runAnalysis}
          style={{ padding: "12px 28px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer", marginBottom: 24 }}
        >
          Mulai Analisis
        </button>
      )}

      {analyzing && (
        <div style={{ padding: 24, background: "var(--bg-surface)", borderRadius: 4, border: "1px solid var(--border-color)", marginBottom: 24, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid var(--border-color)", borderTopColor: "var(--accent-blue)", animation: "spin 0.8s linear infinite" }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>Menganalisis perkara...</span>
        </div>
      )}

      {error && (
        <div style={{ padding: 16, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 24 }}>
          {error}
          <button onClick={runAnalysis} style={{ marginLeft: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>
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
