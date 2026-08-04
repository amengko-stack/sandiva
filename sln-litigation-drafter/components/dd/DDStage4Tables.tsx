"use client";

import { useState } from "react";
import { useDD } from "@/context/DDContext";
import DDReviewTable from "@/components/dd/DDReviewTable";
import DDSourcePreview from "@/components/dd/DDSourcePreview";
import type { DDExtractionRow } from "@/types/dd";

export default function DDStage4Tables() {
  const { state, dispatch } = useDD();
  const [rowsByEntity, setRowsByEntity] = useState<Record<string, DDExtractionRow[]>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<{ entityId: string; sourceFile: string; verbatim: string } | null>(null);
  const t = state.transaction;
  if (!t) return <div>Selesaikan Stage 1 dahulu.</div>;

  const run = async (eid: string) => {
    if (running[eid]) return;
    setRunning((r) => ({ ...r, [eid]: true }));
    setProgress((p) => ({ ...p, [eid]: "Memulai…" }));
    setWarnings((w) => ({ ...w, [eid]: [] }));
    try {
      const res = await fetch("/api/dd/extract-table", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Gagal");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let sawDone = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (!sawDone) {
            throw new Error("Stream ekstraksi tabel terputus sebelum selesai — jalankan ulang entitas ini.");
          }
          break;
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const msg = JSON.parse(line);
          if (msg.type === "start" && msg.total === 0) setProgress((p) => ({ ...p, [eid]: "Tidak ada perjanjian terklasifikasi untuk entitas ini." }));
          if (msg.type === "row") setProgress((p) => ({ ...p, [eid]: `Perjanjian ${msg.index + 1}/${msg.total}` }));
          if (msg.type === "warning") {
            setWarnings((w) => {
              const curr = w[eid] ?? [];
              return { ...w, [eid]: [...curr, msg.message] };
            });
            setProgress((p) => ({ ...p, [eid]: `⚠ ${msg.message}` }));
          }
          if (msg.type === "done") {
            sawDone = true;
            setRowsByEntity((r) => ({ ...r, [eid]: msg.rows }));
            setProgress((p) => ({ ...p, [eid]: `Selesai — ${msg.rows.length} perjanjian` }));
            dispatch({ type: "MARK_PROGRESS", entityId: eid, patch: { tabled: true } });
          }
          if (msg.type === "error") throw new Error(msg.message);
        }
      }
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      setRunning((r) => ({ ...r, [eid]: false }));
    }
  };

  const allDone = t.entities.every((e) => state.progress[e.id]?.tabled);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1>4 — Tabel Ketentuan Kunci</h1>
      <p style={{ color: "var(--text-muted)" }}>Sel merah ⚠ = klausul yang terpicu oleh jenis transaksi ini. Klik sel untuk melihat kutipan sumber.</p>
      {t.entities.map((e) => (
        <div key={e.id} style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>{e.name}</strong>
            <button onClick={() => run(e.id)} disabled={!state.progress[e.id]?.classified || running[e.id]}>
              {running[e.id] ? "Mengekstrak…" : "Ekstrak tabel"}
            </button>
          </div>
          {progress[e.id] && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{progress[e.id]}</div>}
          {warnings[e.id] && warnings[e.id].length > 0 && (
            <div style={{ background: "#fef3c7", color: "#78350f", border: "1px solid #fcd34d", borderRadius: 4, padding: 8, fontSize: 12 }}>
              {warnings[e.id].map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          )}
          <DDReviewTable
            rows={rowsByEntity[e.id] ?? []}
            onOpenSource={(sourceFile, verbatim) => setPreview({ entityId: e.id, sourceFile, verbatim })}
          />
        </div>
      ))}
      {preview && (
        <DDSourcePreview
          sessionId={state.sessionId}
          entityId={preview.entityId}
          sourceFile={preview.sourceFile}
          highlight={preview.verbatim}
          onClose={() => setPreview(null)}
        />
      )}
      <button onClick={() => dispatch({ type: "SET_STAGE", stage: 5 })} disabled={!allDone} style={{ padding: 12, fontWeight: 600 }}>
        Lanjut ke Temuan & Review →
      </button>
    </div>
  );
}
