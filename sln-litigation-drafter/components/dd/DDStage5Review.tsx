"use client";

import { useEffect, useState } from "react";
import { useDD } from "@/context/DDContext";
import DDSourcePreview from "@/components/dd/DDSourcePreview";
import { aspectLabel } from "@/config/ddAspects";
import type { DDConsolidated, DDFinding } from "@/types/dd";

const SEV_ORDER: Record<DDFinding["severity"], number> = { kritis: 0, material: 1, minor: 2 };
const SEV_STYLE: Record<DDFinding["severity"], string> = { kritis: "#fee2e2", material: "#fef3c7", minor: "#f3f4f6" };
const DIM_LABEL: Record<DDFinding["dimension"], string> = {
  kelengkapan: "Kelengkapan", currency: "Keberlakuan", risiko: "Risiko", konsistensi: "Konsistensi",
};

function FindingCard({ f, onAction, onOpenSource }: {
  f: DDFinding;
  onAction: (id: string, patch: Partial<DDFinding>) => void;
  onOpenSource: (f: DDFinding) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(f.editedProblem ?? f.problem);
  const muted = f.status === "accepted" || f.status === "dismissed";
  return (
    <div style={{ background: muted ? "#fafafa" : SEV_STYLE[f.severity], opacity: muted ? 0.6 : 1, borderRadius: 8, padding: 10, display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
        <strong style={{ textTransform: "uppercase" }}>{f.severity}</strong>
        <span>{DIM_LABEL[f.dimension]}</span>
        {f.aspectId && <span>· {aspectLabel(f.aspectId)}</span>}
        {f.verified && <span style={{ color: "#059669" }}>✓ terverifikasi</span>}
        {f.currencyStatus === "superseded" && <span style={{ color: "#b45309" }}>⚠ peraturan diganti</span>}
        {f.currencyStatus === "unknown" && (f.regulationRefs?.length ?? 0) > 0 && <span style={{ color: "#6b7280" }}>? keberlakuan belum dicek</span>}
        <span style={{ marginLeft: "auto", color: "#6b7280" }}>{f.status}</span>
      </div>
      {editing ? (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} style={{ width: "100%" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { onAction(f.id, { status: "edited", editedProblem: text }); setEditing(false); }}>Simpan</button>
            <button onClick={() => setEditing(false)}>Batal</button>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 14 }}>{f.editedProblem ?? f.problem}</div>
      )}
      <div style={{ fontSize: 12, color: "#374151" }}><em>Dampak:</em> {f.whyItMatters}</div>
      <div style={{ fontSize: 12, color: "#374151" }}><em>Tindak lanjut:</em> {f.suggestedFix}</div>
      {f.currencyNote && <div style={{ fontSize: 12, color: "#b45309" }}>{f.currencyNote}</div>}
      <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
        {f.anchor && f.sourceFile && <button onClick={() => onOpenSource(f)}>Lihat sumber</button>}
        <button onClick={() => onAction(f.id, { status: "accepted" })}>Terima</button>
        <button onClick={() => onAction(f.id, { status: "dismissed" })}>Tolak</button>
        <button onClick={() => setEditing(true)}>Edit</button>
        {muted && <button onClick={() => onAction(f.id, { status: "open" })}>Buka lagi</button>}
      </div>
    </div>
  );
}

export default function DDStage5Review() {
  const { state, dispatch } = useDD();
  const [findingsByEntity, setFindingsByEntity] = useState<Record<string, DDFinding[]>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [consolidated, setConsolidated] = useState<DDConsolidated | null>(null);
  const [preview, setPreview] = useState<{ entityId: string; sourceFile: string; verbatim: string } | null>(null);
  const t = state.transaction;

  // Re-hydrate persisted findings on mount: entities marked analyzed in
  // DDContext survive a reload, but local findings state does not — fetch
  // them back instead of forcing an expensive re-run. Fail soft: a fetch
  // error just leaves the list empty. The `f[e.id]?.length ? f :` guard
  // prevents clobbering a fresh in-session run.
  useEffect(() => {
    if (!t) return;
    for (const e of t.entities) {
      if (!state.progress[e.id]?.analyzed) continue;
      fetch(`/api/dd/findings?sessionId=${state.sessionId}&entityId=${e.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.findings?.length) {
            setFindingsByEntity((f) => (f[e.id]?.length ? f : { ...f, [e.id]: d.findings }));
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!t) return <div>Selesaikan Stage 1 dahulu.</div>;

  const analyze = async (eid: string) => {
    // Re-entrancy guard: prevent multiple concurrent analyses for the same entity
    if (running[eid]) return;

    setRunning((r) => ({ ...r, [eid]: true }));
    setProgress((p) => ({ ...p, [eid]: "Memulai…" }));
    try {
      const res = await fetch("/api/dd/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Gagal analisis");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let sawDone = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines.filter(Boolean)) {
            const msg = JSON.parse(line);
            if (msg.type === "step") setProgress((p) => ({ ...p, [eid]: msg.label }));
            if (msg.type === "done") {
              sawDone = true;
              setFindingsByEntity((f) => ({ ...f, [eid]: msg.findings }));
              setProgress((p) => ({ ...p, [eid]: `Selesai — ${msg.findings.length} temuan` }));
            }
            if (msg.type === "error") throw new Error(msg.message);
          }
        }
      } finally {
        reader.cancel();
      }
      if (!sawDone) {
        throw new Error("Stream analisis terputus sebelum selesai — jalankan ulang entitas ini.");
      }
      dispatch({ type: "MARK_PROGRESS", entityId: eid, patch: { analyzed: true } });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      setRunning((r) => ({ ...r, [eid]: false }));
    }
  };

  const onAction = (eid: string) => (id: string, patch: Partial<DDFinding>) =>
    setFindingsByEntity((f) => ({ ...f, [eid]: (f[eid] ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  const saveReview = async (eid: string) => {
    try {
      const res = await fetch("/api/dd/findings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid, findings: findingsByEntity[eid] ?? [] }),
      });
      if (!res.ok) dispatch({ type: "SET_ERROR", error: (await res.json()).error ?? "Gagal menyimpan review" });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Gagal menyimpan review" });
    }
  };

  const runConsolidate = async () => {
    try {
      const res = await fetch("/api/dd/consolidate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
      const data = await res.json();
      if (!res.ok) { dispatch({ type: "SET_ERROR", error: data.error }); return; }
      setConsolidated(data.consolidated);
      dispatch({ type: "SET_CONSOLIDATED", value: true });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Gagal konsolidasi" });
    }
  };

  const sortFindings = (fs: DDFinding[]) =>
    [...fs].sort((a, b) => {
      const mutedA = a.status === "accepted" || a.status === "dismissed" ? 1 : 0;
      const mutedB = b.status === "accepted" || b.status === "dismissed" ? 1 : 0;
      return mutedA - mutedB || SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    });

  const allAnalyzed = t.entities.every((e) => state.progress[e.id]?.analyzed);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1>5 — Temuan & Review (exceptions-first)</h1>
      {t.entities.map((e) => (
        <div key={e.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>{e.name}</strong>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => analyze(e.id)} disabled={running[e.id]}>{running[e.id] ? "Menganalisis…" : "Jalankan analisis"}</button>
              <button onClick={() => saveReview(e.id)} disabled={!findingsByEntity[e.id]}>Simpan review</button>
            </div>
          </div>
          {progress[e.id] && <div style={{ fontSize: 13, color: "#6b7280" }}>{progress[e.id]}</div>}
          <div style={{ display: "grid", gap: 8 }}>
            {sortFindings(findingsByEntity[e.id] ?? []).map((f) => (
              <FindingCard
                key={f.id} f={f} onAction={onAction(e.id)}
                onOpenSource={(x) => x.sourceFile && setPreview({ entityId: e.id, sourceFile: x.sourceFile, verbatim: x.anchor })}
              />
            ))}
          </div>
        </div>
      ))}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>Konsolidasi lintas-entitas</strong>
          <button onClick={runConsolidate} disabled={!allAnalyzed}>Jalankan konsolidasi</button>
        </div>
        {consolidated && (
          <>
            {consolidated.crossEntityFindings.length === 0 && <div style={{ fontSize: 13 }}>Tidak ada temuan lintas-entitas.</div>}
            {consolidated.crossEntityFindings.map((f) => (
              <FindingCard key={f.id} f={f} onAction={() => {}} onOpenSource={() => {}} />
            ))}
          </>
        )}
      </div>

      {preview && (
        <DDSourcePreview
          sessionId={state.sessionId} entityId={preview.entityId}
          sourceFile={preview.sourceFile} highlight={preview.verbatim}
          onClose={() => setPreview(null)}
        />
      )}

      <button onClick={() => dispatch({ type: "SET_STAGE", stage: 6 })} disabled={!allAnalyzed || !state.consolidated} style={{ padding: 12, fontWeight: 600 }}>
        Lanjut ke Ekspor →
      </button>
    </div>
  );
}
