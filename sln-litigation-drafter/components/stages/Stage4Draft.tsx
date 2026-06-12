"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { DraftVersion } from "@/types";

const MAX_REVISIONS = 5;

function fireAndForget(url: string, body: object) {
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export default function Stage4Draft() {
  const { state, dispatch, goToStage } = useWorkflow();
  const draftRef = useRef<HTMLPreElement>(null);
  const [streamError, setStreamError] = useState("");

  // Revision panel state
  const [checkedItems, setCheckedItems] = useState<boolean[]>([]);
  const [freeformInstructions, setFreeformInstructions] = useState("");
  const [pendingInstructions, setPendingInstructions] = useState("");
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);

  // Sync checkedItems length when critiqueItems change
  useEffect(() => {
    setCheckedItems(new Array(state.critiqueItems.length).fill(false));
  }, [state.critiqueItems.length]);

  useEffect(() => {
    if (state.draftText === "" && !state.isDraftStreaming && !state.draftComplete) {
      startStreaming();
    }
  }, []);

  useEffect(() => {
    if (draftRef.current && viewingVersion === null) {
      draftRef.current.scrollTop = draftRef.current.scrollHeight;
    }
  }, [state.draftText, viewingVersion]);

  async function startStreaming(revisionInstructions?: string, currentDraft?: string) {
    dispatch({ type: "SET_DRAFT_STREAMING", value: true });
    setStreamError("");
    setViewingVersion(null);

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
          ...(revisionInstructions ? { revisionInstructions, currentDraft } : {}),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Gagal membuat draf");
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
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
              if (event.stopReason === "end_turn") {
                dispatch({ type: "SET_DRAFT_COMPLETE", value: true });
                // Save version snapshot to SharePoint (fire-and-forget)
                const versionNumber = state.draftVersions.length + 1;
                const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                const filename = `Drafts/${(state.ref || "draf").replace(/\//g, "-")}_v${versionNumber}_${ts}.docx`;
                if (state.folderPath) {
                  fireAndForget("/api/sharepoint-save", {
                    draftText: fullDraft,
                    ref: state.ref,
                    docType: state.docTypeId,
                    claimType: state.claimType,
                    folderPath: state.folderPath,
                    filename,
                  });
                }
                const newVersion: DraftVersion = {
                  version: versionNumber,
                  text: fullDraft,
                  critiqueItems: [],
                  instructions: pendingInstructions,
                  timestamp: new Date().toISOString(),
                };
                dispatch({ type: "ADD_DRAFT_VERSION", version: newVersion });
                dispatch({ type: "SET_DRAFT_VERSION", version: versionNumber });
                setPendingInstructions("");
                runCritique(fullDraft);
              } else {
                setStreamError(
                  `Draf belum lengkap (stop_reason=${event.stopReason ?? "tidak diketahui"}) — kritik tidak dijalankan. Coba buat ulang draf.`
                );
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
      if (res.ok && data.critiqueItems) {
        dispatch({ type: "SET_CRITIQUE", items: data.critiqueItems });
      }
    } catch {}
    dispatch({ type: "SET_CRITIQUE_LOADING", value: false });
  }

  async function startRevision() {
    const selectedCritiques = (state.critiqueItems ?? []).filter((_, i) => checkedItems[i]);
    const parts = [
      selectedCritiques.length
        ? `Poin kritik yang harus diperbaiki:\n${selectedCritiques.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
        : "",
      freeformInstructions.trim()
        ? `Instruksi tambahan drafter:\n${freeformInstructions.trim()}`
        : "",
    ].filter(Boolean);

    if (parts.length === 0) return;
    const combined = parts.join("\n\n");

    setPendingInstructions(combined);
    const prevDraft = state.draftText;
    dispatch({ type: "RESET_DRAFT" });
    setFreeformInstructions("");
    setCheckedItems([]);
    await new Promise((r) => setTimeout(r, 0));
    startStreaming(combined, prevDraft);
  }

  const atRevisionCap = state.draftVersions.length >= MAX_REVISIONS;
  const canRevise =
    !atRevisionCap &&
    !state.isDraftStreaming &&
    state.draftComplete &&
    viewingVersion === null &&
    (checkedItems.some(Boolean) || freeformInstructions.trim().length > 0);

  const displayText =
    viewingVersion !== null
      ? (state.draftVersions.find((v) => v.version === viewingVersion)?.text ?? state.draftText)
      : state.draftText;

  return (
    <div>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
            Draf Dokumen
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            {state.isDraftStreaming
              ? "Sedang menyusun draf..."
              : state.draftComplete
              ? `Draf v${state.draftVersion} selesai.`
              : "Mempersiapkan draf..."}
          </p>
        </div>
        {state.draftComplete && (
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => {
                dispatch({ type: "RESET_DRAFT" });
                setCheckedItems([]);
                setFreeformInstructions("");
                setViewingVersion(null);
                startStreaming();
              }}
              disabled={state.isDraftStreaming}
              style={btnSecondary}
            >
              ↻ Buat Ulang Draf
            </button>
            <button
              onClick={() => runCritique(state.draftText)}
              disabled={state.isCritiqueLoading || !state.draftText.trim() || viewingVersion !== null}
              style={btnSecondary}
            >
              {state.isCritiqueLoading ? "Mengkritisi..." : "⚖ Kritisi Ulang"}
            </button>
            <button onClick={() => goToStage(5)} style={btnPrimary}>
              Lanjut ke Output →
            </button>
          </div>
        )}
      </div>

      {/* ── Error banner ───────────────────────────────────────────────── */}
      {streamError && (
        <div style={{ padding: 16, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 16 }}>
          {streamError}
          <button
            onClick={() => startStreaming()}
            style={{ marginLeft: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}
          >
            Coba lagi
          </button>
        </div>
      )}

      {/* ── Draft display panel ────────────────────────────────────────── */}
      <div style={{ background: "var(--bg-draft)", border: "1px solid var(--border-color)", borderRadius: 4, marginBottom: 24 }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
            DRAF — {(state.docTypeId || "").replace(/_/g, " ").toUpperCase()}
            {state.draftVersion > 0 ? ` — v${viewingVersion ?? state.draftVersion}` : ""}
          </span>
          {state.isDraftStreaming && (
            <>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-blue)", animation: "pulse 1s ease-in-out infinite" }} />
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
            padding: "28px 36px",
            maxHeight: 640,
            overflowY: "auto",
            margin: 0,
            fontSize: 14,
            lineHeight: 1.85,
            minHeight: 200,
            fontFamily: "Georgia, 'Times New Roman', serif",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxWidth: 820,
          }}
        >
          {displayText || (state.isDraftStreaming ? "" : "Menunggu...")}
          {state.isDraftStreaming && (
            <span style={{ borderRight: "2px solid var(--accent-blue)", marginLeft: 1, animation: "blink 0.7s step-end infinite" }}>
              <style>{`@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }`}</style>
            </span>
          )}
        </pre>
      </div>

      {/* ── Version history strip ─────────────────────────────────────── */}
      {state.draftVersions.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>VERSI:</span>
          {state.draftVersions.map((v) => {
            const isCurrent = viewingVersion === null ? v.version === state.draftVersion : v.version === viewingVersion;
            return (
              <button
                key={v.version}
                onClick={() => setViewingVersion(v.version === viewingVersion ? null : v.version)}
                title={v.instructions || "Draf awal"}
                style={{
                  padding: "4px 12px",
                  fontSize: 12,
                  borderRadius: 12,
                  border: `1px solid ${isCurrent ? "var(--accent-blue)" : "var(--border-color)"}`,
                  background: isCurrent ? "var(--accent-blue)" : "transparent",
                  color: isCurrent ? "white" : "var(--text-muted)",
                  cursor: "pointer",
                }}
              >
                v{v.version}
              </button>
            );
          })}
          {viewingVersion !== null && (
            <button
              onClick={() => setViewingVersion(null)}
              style={{ fontSize: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer" }}
            >
              ← kembali ke versi terkini
            </button>
          )}
        </div>
      )}

      {/* ── Prior-version instructions callout ───────────────────────── */}
      {viewingVersion !== null && (() => {
        const v = state.draftVersions.find((x) => x.version === viewingVersion);
        return v?.instructions ? (
          <div style={{ padding: "10px 14px", background: "rgba(41,128,185,0.06)", border: "1px solid rgba(41,128,185,0.2)", borderRadius: 4, fontSize: 12, color: "var(--text-muted)", marginBottom: 20 }}>
            <strong style={{ color: "var(--text-primary)" }}>Instruksi v{v.version}:</strong>{" "}
            {v.instructions.slice(0, 300)}{v.instructions.length > 300 ? "…" : ""}
          </div>
        ) : null;
      })()}

      {/* ── Critique panel ────────────────────────────────────────────── */}
      {(state.isCritiqueLoading || state.critiqueItems.length > 0) && viewingVersion === null && (
        <div style={{ background: "var(--bg-critique)", border: "1px solid #3a1515", borderRadius: 4, marginBottom: 24 }}>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid #3a1515", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "#c0392b", letterSpacing: "0.05em" }}>
              KRITIK OTOMATIS
            </span>
            {!state.isCritiqueLoading && state.critiqueItems.length > 0 && (
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={() => setCheckedItems(new Array(state.critiqueItems.length).fill(true))}
                  style={{ fontSize: 11, color: "#c0392b", background: "none", border: "none", cursor: "pointer" }}
                >
                  Pilih Semua
                </button>
                <button
                  onClick={() => setCheckedItems(new Array(state.critiqueItems.length).fill(false))}
                  style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                >
                  Batalkan Semua
                </button>
              </div>
            )}
          </div>
          <div style={{ padding: "16px 20px" }}>
            {state.isCritiqueLoading ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid #3a1515", borderTopColor: "#c0392b", animation: "spin 0.8s linear infinite" }} />
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                <span style={{ fontSize: 13, color: "#c0392b" }}>Menganalisis kelemahan draf...</span>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {state.critiqueItems.map((item, i) => (
                  <label
                    key={i}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      padding: "10px 12px",
                      borderRadius: 4,
                      cursor: "pointer",
                      background: checkedItems[i] ? "rgba(192,57,43,0.12)" : "transparent",
                      border: `1px solid ${checkedItems[i] ? "#c0392b" : "transparent"}`,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checkedItems[i] ?? false}
                      onChange={(e) => {
                        const next = [...checkedItems];
                        next[i] = e.target.checked;
                        setCheckedItems(next);
                      }}
                      style={{ marginTop: 2, flexShrink: 0, accentColor: "#c0392b" }}
                    />
                    <span style={{ fontSize: 13, color: "#e8a89a", lineHeight: 1.7 }}>{item}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Free-form revision instructions ──────────────────────────── */}
      {state.draftComplete && !state.isDraftStreaming && viewingVersion === null && (
        <div style={{ marginBottom: 24 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
            Instruksi Revisi Tambahan
          </label>
          <textarea
            value={freeformInstructions}
            onChange={(e) => setFreeformInstructions(e.target.value)}
            placeholder="Instruksi tambahan (opsional) — misalnya: perkuat bagian kausalitas, persingkat duduk perkara, hapus petitum dwangsom..."
            rows={3}
            disabled={atRevisionCap}
            style={{
              width: "100%",
              padding: "10px 12px",
              background: "var(--bg-input)",
              border: "1px solid var(--border-color)",
              borderRadius: 4,
              color: "var(--text-primary)",
              fontSize: 13,
              resize: "vertical",
              fontFamily: "var(--font-inter), sans-serif",
              boxSizing: "border-box",
              opacity: atRevisionCap ? 0.5 : 1,
            }}
          />
          {atRevisionCap && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
              Maksimum {MAX_REVISIONS} revisi tercapai — lanjut ke output.
            </p>
          )}
        </div>
      )}

      {/* ── Revision history detail list ─────────────────────────────── */}
      {state.draftVersions.length > 1 && viewingVersion === null && (
        <div style={{ marginBottom: 24, borderTop: "1px solid var(--border-color)", paddingTop: 16 }}>
          <p style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 10 }}>
            Riwayat Revisi
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {state.draftVersions.map((v) => (
              <div key={v.version} style={{ fontSize: 12, color: "var(--text-muted)", padding: "6px 10px", background: "var(--bg-input)", borderRadius: 4 }}>
                <strong style={{ color: "var(--text-primary)" }}>v{v.version}</strong>
                {v.instructions
                  ? ` — ${v.instructions.slice(0, 100)}${v.instructions.length > 100 ? "…" : ""}`
                  : " — Draf awal"}
                <span style={{ marginLeft: 8, opacity: 0.6 }}>
                  ({new Date(v.timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Bottom action row ─────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, marginTop: 8, alignItems: "center" }}>
        <button onClick={() => goToStage(3)} style={btnSecondary}>
          ← Kembali
        </button>
        {state.draftComplete && !state.isDraftStreaming && viewingVersion === null && !atRevisionCap && (
          <button
            onClick={startRevision}
            disabled={!canRevise}
            style={{
              ...btnSecondary,
              opacity: canRevise ? 1 : 0.4,
              cursor: canRevise ? "pointer" : "not-allowed",
              borderColor: canRevise ? "#c0392b" : undefined,
              color: canRevise ? "#c0392b" : undefined,
            }}
          >
            ↻ Revisi Draf{checkedItems.filter(Boolean).length > 0 ? ` (${checkedItems.filter(Boolean).length} poin)` : ""}
          </button>
        )}
        {state.draftComplete && (
          <button onClick={() => goToStage(5)} style={{ ...btnPrimary, marginLeft: "auto" }}>
            Lanjut ke Output →
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Style helpers ──────────────────────────────────────────────────────────

const btnSecondary: React.CSSProperties = {
  padding: "10px 16px",
  background: "transparent",
  border: "1px solid var(--border-color)",
  borderRadius: 4,
  color: "var(--text-muted)",
  fontSize: 13,
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  padding: "10px 24px",
  background: "var(--accent-blue)",
  color: "white",
  border: "none",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
};
