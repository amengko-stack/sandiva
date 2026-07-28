"use client";

import { useEffect, useRef, useState } from "react";
import { useDD } from "@/context/DDContext";
import DDSourcePreview from "@/components/dd/DDSourcePreview";
import { aspectLabel } from "@/config/ddAspects";
import type { DDConsolidated, DDFinding } from "@/types/dd";

const SEV_ORDER: Record<DDFinding["severity"], number> = { kritis: 0, material: 1, minor: 2 };
const SEV_STYLE: Record<DDFinding["severity"], string> = { kritis: "#fee2e2", material: "#fef3c7", minor: "#f3f4f6" };
const DIM_LABEL: Record<DDFinding["dimension"], string> = {
  kelengkapan: "Kelengkapan", currency: "Keberlakuan", risiko: "Risiko", konsistensi: "Konsistensi",
};

function FindingCard({ f, onAction, onOpenSource, readOnly }: {
  f: DDFinding;
  onAction: (id: string, patch: Partial<DDFinding>) => void;
  onOpenSource: (f: DDFinding) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(f.editedProblem ?? f.problem);
  const muted = f.status === "accepted" || f.status === "dismissed";
  return (
    <div style={{ background: muted ? "#fafafa" : SEV_STYLE[f.severity], color: "#1f2937", opacity: muted ? 0.6 : 1, borderRadius: 8, padding: 10, display: "grid", gap: 6 }}>
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
      {!readOnly && (
        <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
          {f.anchor && f.sourceFile && <button onClick={() => onOpenSource(f)}>Lihat sumber</button>}
          <button onClick={() => onAction(f.id, { status: "accepted" })}>Terima</button>
          <button onClick={() => onAction(f.id, { status: "dismissed" })}>Tolak</button>
          <button onClick={() => setEditing(true)}>Edit</button>
          {muted && <button onClick={() => onAction(f.id, { status: "open" })}>Buka lagi</button>}
        </div>
      )}
    </div>
  );
}

type SaveStatus = "idle" | "pending" | "saved" | "failed";

export default function DDStage5Review() {
  const { state, dispatch } = useDD();
  const [findingsByEntity, setFindingsByEntity] = useState<Record<string, DDFinding[]>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [consolidated, setConsolidated] = useState<DDConsolidated | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  // Per-entity save feedback: reviewer decisions auto-save on a debounce, so
  // without a visible status the "Simpan review" button looks like a no-op.
  const [saveStatus, setSaveStatus] = useState<Record<string, SaveStatus>>({});
  const [savedAt, setSavedAt] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ entityId: string; sourceFile: string; verbatim: string } | null>(null);
  const t = state.transaction;

  // Tracks the last JSON successfully PUT per entity, so the auto-persist
  // effect below never re-sends unchanged content (and never loops).
  const lastSavedRef = useRef<Record<string, string>>({});
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const persistEntity = async (eid: string, findings: DDFinding[]) => {
    const json = JSON.stringify(findings);
    setSaveStatus((s) => ({ ...s, [eid]: "pending" }));
    try {
      const res = await fetch("/api/dd/findings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid, findings }),
      });
      if (!res.ok) {
        setSaveStatus((s) => ({ ...s, [eid]: "failed" }));
        dispatch({ type: "SET_ERROR", error: (await res.json()).error ?? "Gagal menyimpan review" });
        return;
      }
      lastSavedRef.current[eid] = json;
      setSaveStatus((s) => ({ ...s, [eid]: "saved" }));
      setSavedAt((s) => ({ ...s, [eid]: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) }));
    } catch (err) {
      setSaveStatus((s) => ({ ...s, [eid]: "failed" }));
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Gagal menyimpan review" });
    }
  };

  // Re-hydrate persisted findings on mount: entities marked analyzed in
  // DDContext survive a reload, but local findings state does not — fetch
  // them back instead of forcing an expensive re-run. Fail soft: a fetch
  // error just leaves the list empty. The `f[e.id]?.length ? f :` guard
  // prevents clobbering a fresh in-session run. Seeding lastSavedRef here
  // stops the auto-persist effect below from immediately re-PUTting content
  // that's already exactly what's on the server.
  useEffect(() => {
    if (!t) return;
    for (const e of t.entities) {
      if (!state.progress[e.id]?.analyzed) continue;
      fetch(`/api/dd/findings?sessionId=${state.sessionId}&entityId=${e.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.findings?.length) {
            lastSavedRef.current[e.id] = JSON.stringify(d.findings);
            setFindingsByEntity((f) => (f[e.id]?.length ? f : { ...f, [e.id]: d.findings }));
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-hydrate a previously computed consolidation the same way findings are.
  // Self-healing: the boolean lives in sessionStorage (per-tab), so a new tab
  // would otherwise show "not consolidated" even though the blob exists.
  useEffect(() => {
    fetch(`/api/dd/consolidate?sessionId=${state.sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.consolidated) return;
        setConsolidated((c) => c ?? d.consolidated);
        if (!state.consolidated) dispatch({ type: "SET_CONSOLIDATED", value: true });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-persist reviewer decisions (accept/dismiss/edit/re-open) so they are
  // guaranteed into the eventual deliverables instead of depending on the
  // lawyer remembering to click "Simpan review". Debounced ~800ms per entity;
  // the lastSavedRef guard skips entities whose content already matches what
  // was last saved, which prevents this effect from ever re-triggering itself
  // in a PUT loop.
  useEffect(() => {
    for (const eid of Object.keys(findingsByEntity)) {
      const findings = findingsByEntity[eid];
      if (!findings?.length) continue;
      const json = JSON.stringify(findings);
      if (lastSavedRef.current[eid] === json) continue;
      if (saveTimersRef.current[eid]) clearTimeout(saveTimersRef.current[eid]);
      saveTimersRef.current[eid] = setTimeout(() => { void persistEntity(eid, findings); }, 800);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingsByEntity]);

  // Flush any pending debounce timers on unmount so they never fire (and
  // touch state) after the component is gone.
  useEffect(() => {
    const timers = saveTimersRef.current;
    return () => {
      Object.values(timers).forEach(clearTimeout);
    };
  }, []);

  if (!t) return <div>Selesaikan Stage 1 dahulu.</div>;

  // A one-company DD has nothing to consolidate ACROSS — the cross-entity step
  // is hidden for it and its aspect rollup runs automatically instead.
  const isSingleEntity = t.entities.length < 2;

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

      // Single-entity DD: "cross-entity consolidation" is meaningless, but the
      // aspect rollup it computes still feeds the Word/Excel recap — and for one
      // entity it runs with NO model call at all. Run it silently so the report
      // is complete without making the lawyer click a confusing extra step.
      if (isSingleEntity) void runConsolidate({ silent: true });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      setRunning((r) => ({ ...r, [eid]: false }));
    }
  };

  const onAction = (eid: string) => (id: string, patch: Partial<DDFinding>) =>
    setFindingsByEntity((f) => ({ ...f, [eid]: (f[eid] ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  // Explicit flush: bypasses the debounce timer and saves immediately,
  // regardless of the auto-persist effect's schedule.
  const saveReview = (eid: string) => {
    if (saveTimersRef.current[eid]) clearTimeout(saveTimersRef.current[eid]);
    void persistEntity(eid, findingsByEntity[eid] ?? []);
  };

  // opts.silent: the automatic single-entity rollup — a failure there must not
  // throw a scary banner at a lawyer who never asked for "consolidation"; the
  // export path already handles a missing rollup by omitting that section.
  const runConsolidate = async (opts?: { silent?: boolean }) => {
    if (consolidating) return;
    setConsolidating(true);
    try {
      const res = await fetch("/api/dd/consolidate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (!opts?.silent) dispatch({ type: "SET_ERROR", error: data.error });
        else console.error("[dd/stage5] rollup otomatis gagal:", data.error);
        return;
      }
      setConsolidated(data.consolidated);
      dispatch({ type: "SET_CONSOLIDATED", value: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Gagal konsolidasi";
      if (!opts?.silent) dispatch({ type: "SET_ERROR", error: message });
      else console.error("[dd/stage5] rollup otomatis gagal:", message);
    } finally {
      setConsolidating(false);
    }
  };

  const sortFindings = (fs: DDFinding[]) =>
    [...fs].sort((a, b) => {
      const mutedA = a.status === "accepted" || a.status === "dismissed" ? 1 : 0;
      const mutedB = b.status === "accepted" || b.status === "dismissed" ? 1 : 0;
      return mutedA - mutedB || SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    });

  const allAnalyzed = t.entities.every((e) => state.progress[e.id]?.analyzed);
  const pendingEntities = t.entities.filter((e) => !state.progress[e.id]?.analyzed);

  // Consolidation is NOT required to export: the builders omit that section
  // when the rollup is missing (load-results returns null, docx/excel skip it).
  // Multi-entity runs get an informed confirm instead of a hard block, so a
  // failed consolidation can never lock the lawyer out of their deliverables.
  const continueToExport = () => {
    if (!isSingleEntity && !state.consolidated) {
      const ok = window.confirm(
        "Konsolidasi lintas-entitas belum dijalankan. Laporan akan dibuat tanpa temuan lintas-entitas dan tanpa rekap kelengkapan per aspek. Lanjutkan ke ekspor?"
      );
      if (!ok) return;
    }
    dispatch({ type: "SET_STAGE", stage: 6 });
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1>5 — Temuan & Review (exceptions-first)</h1>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Keputusan review (Terima / Tolak / Edit) tersimpan otomatis. Tombol “Simpan review” hanya untuk menyimpan segera.
        Data sesi analisis tersimpan 24 jam — simpan hasil ke SharePoint sebelum mengakhiri hari kerja.
      </div>
      {t.entities.map((e) => (
        <div key={e.id} style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong>{e.name}</strong>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {saveStatus[e.id] === "pending" && (
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Menyimpan…</span>
              )}
              {saveStatus[e.id] === "saved" && (
                <span style={{ fontSize: 13, color: "var(--success)" }}>✓ Tersimpan {savedAt[e.id]}</span>
              )}
              {saveStatus[e.id] === "failed" && (
                <span style={{ fontSize: 13, color: "var(--error)" }}>Gagal menyimpan</span>
              )}
              <button onClick={() => analyze(e.id)} disabled={running[e.id]}>{running[e.id] ? "Menganalisis…" : "Jalankan analisis"}</button>
              <button onClick={() => saveReview(e.id)} disabled={!findingsByEntity[e.id] || saveStatus[e.id] === "pending"}>Simpan review</button>
            </div>
          </div>
          {progress[e.id] && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{progress[e.id]}</div>}
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

      {isSingleEntity ? (
        // One company: no cross-entity step to show. The aspect rollup that
        // feeds the report's "Rekap Kelengkapan per Aspek" runs automatically
        // after analysis (no model call), so there is nothing to click here.
        state.consolidated && (
          <div style={{ fontSize: 13, color: "var(--success)" }}>✓ Rekap kelengkapan aspek siap untuk laporan</div>
        )
      ) : (
        <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong>Konsolidasi lintas-entitas</strong>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {state.consolidated && !consolidating && (
                <span style={{ fontSize: 13, color: "var(--success)" }}>
                  ✓ Konsolidasi selesai
                  {consolidated?.generatedAt
                    ? ` — ${new Date(consolidated.generatedAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
                    : ""}
                </span>
              )}
              <button onClick={() => runConsolidate()} disabled={!allAnalyzed || consolidating}>
                {consolidating ? "Menjalankan konsolidasi…" : state.consolidated ? "Jalankan ulang konsolidasi" : "Jalankan konsolidasi"}
              </button>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Membandingkan temuan antar-perusahaan dan menghasilkan rekap kelengkapan per aspek untuk laporan. Opsional —
            ekspor tetap bisa dijalankan tanpa ini.
          </div>
          {consolidated && (
            <>
              {consolidated.crossEntityFindings.length === 0 && <div style={{ fontSize: 13 }}>Tidak ada temuan lintas-entitas.</div>}
              {consolidated.crossEntityFindings.map((f) => (
                <FindingCard key={f.id} f={f} onAction={() => {}} onOpenSource={() => {}} readOnly />
              ))}
            </>
          )}
        </div>
      )}

      {preview && (
        <DDSourcePreview
          sessionId={state.sessionId} entityId={preview.entityId}
          sourceFile={preview.sourceFile} highlight={preview.verbatim}
          onClose={() => setPreview(null)}
        />
      )}

      {!allAnalyzed && (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Belum bisa ekspor — analisis belum dijalankan untuk: {pendingEntities.map((e) => e.name).join(", ")}.
        </div>
      )}
      <button onClick={continueToExport} disabled={!allAnalyzed} style={{ padding: 12, fontWeight: 600 }}>
        Lanjut ke Ekspor →
      </button>
    </div>
  );
}
