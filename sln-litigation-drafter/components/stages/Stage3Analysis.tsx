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
  const [extracting, setExtracting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [editedAnalysis, setEditedAnalysis] = useState<CaseAnalysis | null>(
    state.caseAnalysis
  );

  async function runExtractAndAnalyze() {
    setExtracting(true);
    setError("");
    setProgress("Mengekstrak teks dari dokumen...");

    try {
      // Step 1: Extract text
      const extractRes = await fetch("/api/sharepoint/read-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: state.selectedFiles }),
      });
      const extractData = await extractRes.json();
      if (!extractRes.ok) throw new Error(extractData.error || "Gagal mengekstrak dokumen");

      setExtracting(false);
      setAnalyzing(true);
      setProgress("Menganalisis perkara...");

      // Step 2: Analyze
      const analyzeRes = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentTexts: extractData.documentTexts,
          docTypeId: state.docTypeId,
          practiceAreaId: state.practiceAreaId,
          claimType: state.claimType,
        }),
      });
      const analyzeData = await analyzeRes.json();
      if (!analyzeRes.ok) throw new Error(analyzeData.error || "Gagal menganalisis perkara");

      dispatch({ type: "SET_CASE_ANALYSIS", analysis: analyzeData.analysis });
      setEditedAnalysis(analyzeData.analysis);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setExtracting(false);
      setAnalyzing(false);
      setProgress("");
    }
  }

  function updateSection(key: keyof CaseAnalysis, value: string) {
    if (!editedAnalysis) return;
    const updated = { ...editedAnalysis, [key]: value };
    setEditedAnalysis(updated);
    dispatch({ type: "SET_CASE_ANALYSIS", analysis: updated });
  }

  function handleProceed() {
    if (editedAnalysis) {
      dispatch({ type: "SET_CASE_ANALYSIS", analysis: editedAnalysis });
    }
    goToStage(4);
  }

  const isLoading = extracting || analyzing;

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
        Analisis Perkara
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
        Aplikasi akan mengekstrak teks dari {state.selectedFiles.length} file dan menganalisis perkara.
      </p>

      {!state.caseAnalysis && !isLoading && (
        <button
          onClick={runExtractAndAnalyze}
          style={{
            padding: "12px 28px",
            background: "var(--accent-blue)",
            color: "white",
            border: "none",
            borderRadius: 4,
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
            marginBottom: 24,
          }}
        >
          Mulai Ekstraksi & Analisis
        </button>
      )}

      {isLoading && (
        <div
          style={{
            padding: 24,
            background: "var(--bg-surface)",
            borderRadius: 4,
            border: "1px solid var(--border-color)",
            marginBottom: 24,
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <div
            style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              border: "2px solid var(--border-color)",
              borderTopColor: "var(--accent-blue)",
              animation: "spin 0.8s linear infinite",
            }}
          />
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>{progress}</span>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: 16,
            background: "rgba(192, 57, 43, 0.1)",
            border: "1px solid var(--error)",
            borderRadius: 4,
            color: "var(--error)",
            fontSize: 13,
            marginBottom: 24,
          }}
        >
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
          <div
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              marginBottom: 16,
              padding: "10px 14px",
              background: "rgba(91, 155, 213, 0.06)",
              borderRadius: 4,
              border: "1px solid rgba(91, 155, 213, 0.2)",
            }}
          >
            Tinjau dan koreksi hasil analisis jika diperlukan sebelum membuat draf.
          </div>

          {SECTION_LABELS.map(({ key, label }) => (
            <div key={key} style={{ marginBottom: 20 }}>
              <label
                style={{
                  display: "block",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--accent-gold)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                {label}
              </label>
              <textarea
                value={editedAnalysis[key] || ""}
                onChange={(e) => updateSection(key, e.target.value)}
                rows={4}
                style={{
                  resize: "vertical",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              />
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
        <button
          onClick={() => goToStage(2)}
          style={{
            padding: "10px 20px",
            background: "transparent",
            border: "1px solid var(--border-color)",
            borderRadius: 4,
            color: "var(--text-muted)",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          ← Kembali
        </button>
        {editedAnalysis && (
          <button
            onClick={handleProceed}
            style={{
              padding: "10px 24px",
              background: "var(--accent-blue)",
              color: "white",
              border: "none",
              borderRadius: 4,
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Buat Draf →
          </button>
        )}
      </div>
    </div>
  );
}
