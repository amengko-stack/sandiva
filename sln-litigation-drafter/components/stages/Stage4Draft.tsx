"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";

export default function Stage4Draft() {
  const { state, dispatch, goToStage } = useWorkflow();
  const draftRef = useRef<HTMLPreElement>(null);
  const [streamError, setStreamError] = useState("");

  useEffect(() => {
    if (state.draftText === "" && !state.isDraftStreaming && !state.draftComplete) {
      startStreaming();
    }
  }, []);

  useEffect(() => {
    if (draftRef.current) {
      draftRef.current.scrollTop = draftRef.current.scrollHeight;
    }
  }, [state.draftText]);

  async function startStreaming() {
    dispatch({ type: "SET_DRAFT_STREAMING", value: true });
    setStreamError("");

    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docTypeId: state.docTypeId,
          practiceAreaId: state.practiceAreaId,
          claimType: state.claimType,
          pihak: state.pihak,
          ref: state.ref,
          caseAnalysis: state.caseAnalysis,
          userCorrections: state.userCorrections,
          interviewAnswers: state.interviewAnswers,
          strategicAssessment: state.strategicAssessment,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Gagal membuat draf");
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Accumulate locally: state.draftText in this closure is stale (captured
      // before streaming), so the critique must receive this local copy.
      let fullDraft = "";

      while (true) {
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
            const event = JSON.parse(jsonStr);
            if (event.chunk) {
              fullDraft += event.chunk;
              dispatch({ type: "APPEND_DRAFT", chunk: event.chunk });
            } else if (event.done) {
              console.log(`[stage4] draft done stopReason=${event.stopReason ?? "(not sent)"} draftChars=${fullDraft.length}`);
              dispatch({ type: "SET_DRAFT_STREAMING", value: false });
              // Critique must never run on a truncated draft. end_turn = complete;
              // max_tokens after all continuation calls = still incomplete.
              if (event.stopReason === "max_tokens") {
                setStreamError(
                  "Draf belum lengkap — batas keluaran model tercapai meski sudah dilanjutkan beberapa kali. Coba buat ulang draf."
                );
              } else {
                dispatch({ type: "SET_DRAFT_COMPLETE", value: true });
                runCritique(fullDraft);
              }
            } else if (event.error) {
              throw new Error(event.error);
            }
          } catch {}
        }
      }
    } catch (e: unknown) {
      setStreamError(e instanceof Error ? e.message : "Terjadi kesalahan saat membuat draf");
      dispatch({ type: "SET_DRAFT_STREAMING", value: false });
    }
  }

  async function runCritique(draftText: string) {
    if (!draftText.trim()) {
      console.warn("[stage4] critique skipped: empty draft text");
      return;
    }
    dispatch({ type: "SET_CRITIQUE_LOADING", value: true });
    try {
      const res = await fetch("/api/critique", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftText,
          docTypeId: state.docTypeId,
          caseAnalysis: state.caseAnalysis,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        dispatch({ type: "SET_CRITIQUE", text: data.critiqueText });
      }
    } catch {}
    dispatch({ type: "SET_CRITIQUE_LOADING", value: false });
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
            Draf Dokumen
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            {state.isDraftStreaming
              ? "Sedang menyusun draf..."
              : state.draftComplete
              ? "Draf selesai."
              : "Mempersiapkan draf..."}
          </p>
        </div>
        {state.draftComplete && (
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => {
                dispatch({ type: "RESET_DRAFT" });
                startStreaming();
              }}
              disabled={state.isDraftStreaming}
              style={{
                padding: "10px 16px",
                background: "transparent",
                border: "1px solid var(--border-color)",
                borderRadius: 4,
                color: "var(--text-muted)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              ↻ Buat Ulang Draf
            </button>
            <button
              onClick={() => runCritique(state.draftText)}
              disabled={state.isCritiqueLoading || !state.draftText.trim()}
              style={{
                padding: "10px 16px",
                background: "transparent",
                border: "1px solid var(--border-color)",
                borderRadius: 4,
                color: "var(--text-muted)",
                fontSize: 13,
                cursor: state.isCritiqueLoading ? "wait" : "pointer",
              }}
            >
              {state.isCritiqueLoading ? "Mengkritisi..." : "⚖ Kritisi Ulang"}
            </button>
            <button
              onClick={() => goToStage(5)}
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
              Lanjut ke Output →
            </button>
          </div>
        )}
      </div>

      {streamError && (
        <div
          style={{
            padding: 16,
            background: "rgba(192, 57, 43, 0.1)",
            border: "1px solid var(--error)",
            borderRadius: 4,
            color: "var(--error)",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {streamError}
          <button
            onClick={startStreaming}
            style={{ marginLeft: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}
          >
            Coba lagi
          </button>
        </div>
      )}

      {/* Draft panel */}
      <div
        style={{
          background: "var(--bg-draft)",
          border: "1px solid var(--border-color)",
          borderRadius: 4,
          marginBottom: state.critiqueText ? 24 : 0,
        }}
      >
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            DRAF — {(state.docTypeId || "").replace(/_/g, " ").toUpperCase()}
          </span>
          {state.isDraftStreaming && (
            <>
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--accent-blue)",
                  animation: "pulse 1s ease-in-out infinite",
                }}
              />
              <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
              <span style={{ fontSize: 11, color: "var(--accent-blue)" }}>Menyusun...</span>
            </>
          )}
          {state.ref && (
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto", fontFamily: "monospace" }}>
              {state.ref}
            </span>
          )}
        </div>
        <pre
          ref={draftRef}
          className="draft-text"
          style={{
            padding: "24px 28px",
            maxHeight: 600,
            overflowY: "auto",
            margin: 0,
            fontSize: 14,
            minHeight: 200,
          }}
        >
          {state.draftText || (state.isDraftStreaming ? "" : "Menunggu...")}
          {state.isDraftStreaming && (
            <span style={{ borderRight: "2px solid var(--accent-blue)", marginLeft: 1, animation: "blink 0.7s step-end infinite" }}>
              <style>{`@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }`}</style>
            </span>
          )}
        </pre>
      </div>

      {/* Critique panel */}
      {(state.isCritiqueLoading || state.critiqueText) && (
        <div
          style={{
            background: "var(--bg-critique)",
            border: "1px solid #3a1515",
            borderRadius: 4,
          }}
        >
          <div
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid #3a1515",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 500, color: "#c0392b", letterSpacing: "0.05em" }}>
              KRITIK OTOMATIS
            </span>
          </div>
          <div style={{ padding: "20px 24px" }}>
            {state.isCritiqueLoading ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    border: "2px solid #3a1515",
                    borderTopColor: "#c0392b",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                <span style={{ fontSize: 13, color: "#c0392b" }}>Menganalisis kelemahan draf...</span>
              </div>
            ) : (
              <pre
                style={{
                  color: "#e8a89a",
                  fontSize: 13,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                  fontFamily: "var(--font-inter), sans-serif",
                }}
              >
                {state.critiqueText}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Bottom nav */}
      <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
        <button
          onClick={() => goToStage(3)}
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
      </div>
    </div>
  );
}
