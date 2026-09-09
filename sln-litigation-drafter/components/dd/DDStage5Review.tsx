"use client";

import { useEffect, useRef, useState } from "react";
import { useDD } from "@/context/DDContext";
import DDSourcePreview from "@/components/dd/DDSourcePreview";
import { aspectLabel } from "@/config/ddAspects";
import { FindingsSaveQueue, type ReviewDraft, type ReviewSaveStatus } from "@/lib/dd/findings-save";
import type { DDConsolidated, DDFinding } from "@/types/dd";

const SEV_ORDER: Record<DDFinding["severity"], number> = { kritis: 0, material: 1, minor: 2 };
const SEV_STYLE: Record<DDFinding["severity"], string> = { kritis: "#fee2e2", material: "#fef3c7", minor: "#f3f4f6" };
const DIM_LABEL: Record<DDFinding["dimension"], string> = {
  kelengkapan: "Kelengkapan", currency: "Keberlakuan", risiko: "Risiko", konsistensi: "Konsistensi",
};

function FindingCard({ f, onAction, onOpenSource, readOnly, onEditingChange }: {
  f: DDFinding;
  onAction: (id: string, patch: Partial<DDFinding>) => void;
  onOpenSource: (f: DDFinding) => void;
  readOnly?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(f.editedProblem ?? f.problem);
  useEffect(() => { if (!editing) setText(f.editedProblem ?? f.problem); }, [f.editedProblem, f.problem, editing]);
  const muted = f.status === "accepted" || f.status === "dismissed";
  return (
    <div style={{ background: muted ? "#fafafa" : SEV_STYLE[f.severity], color: "#1f2937", opacity: muted ? 0.6 : 1, borderRadius: 8, padding: 10, display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
        <strong style={{ textTransform: "uppercase" }}>{f.severity}</strong>
        <span>{DIM_LABEL[f.dimension]}</span>
        {f.aspectId && <span>· {aspectLabel(f.aspectId)}</span>}
        {f.verified && <span style={{ color: "#059669" }}>✓ terverifikasi</span>}
        {f.verification?.status === "refuted" && <span style={{ color: "#b91c1c" }}>✗ dibantah verifier</span>}
        {f.verification?.status === "source_unresolved" && <span style={{ color: "#b45309" }}>? sumber verifier tidak terselesaikan</span>}
        {f.verification?.status === "verification_failed" && <span style={{ color: "#b45309" }}>? verifikasi gagal</span>}
        {f.currencyStatus === "superseded" && <span style={{ color: "#b45309" }}>⚠ ketentuan dicabut/diganti</span>}
        {f.currencyStatus === "amended" && <span style={{ color: "#6b7280" }}>· ketentuan diubah, masih berlaku</span>}
        {f.currencyStatus === "unknown" && (f.regulationRefs?.length ?? 0) > 0 && <span style={{ color: "#6b7280" }}>? keberlakuan belum dicek</span>}
        <span style={{ marginLeft: "auto", color: "#6b7280" }}>{f.status}</span>
      </div>
      {editing ? (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} style={{ width: "100%" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { onAction(f.id, { status: "edited", editedProblem: text }); setEditing(false); onEditingChange?.(false); }}>Simpan</button>
            <button onClick={() => { setEditing(false); onEditingChange?.(false); }}>Batal</button>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 14 }}>{f.editedProblem ?? f.problem}</div>
      )}
      <div style={{ fontSize: 12, color: "#374151" }}><em>Dampak:</em> {f.whyItMatters}</div>
      <div style={{ fontSize: 12, color: "#374151" }}><em>Tindak lanjut:</em> {f.suggestedFix}</div>
      {f.currencyNote && <div style={{ fontSize: 12, color: "#b45309" }}>{f.currencyNote}</div>}
      {f.verification && f.verification.status !== "supported" && (
        <div style={{ fontSize: 12, color: "#7f1d1d" }}><em>Alasan verifier:</em> {f.verification.reason}</div>
      )}
      {!readOnly && (
        <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
          {f.anchor && f.sourceFile && <button onClick={() => onOpenSource(f)}>Lihat sumber</button>}
          <button onClick={() => onAction(f.id, { status: "accepted" })}>Terima</button>
          <button onClick={() => onAction(f.id, { status: "dismissed" })}>Tolak</button>
          <button onClick={() => { setEditing(true); onEditingChange?.(true); }}>Edit</button>
          {muted && <button onClick={() => onAction(f.id, { status: "open" })}>Buka lagi</button>}
        </div>
      )}
    </div>
  );
}

type SaveStatus = ReviewSaveStatus;

export interface NarrativeNotice { generatedAt: string | null; notes: string[] }

export function narrativeNoticeFromResponse(value: unknown): NarrativeNotice {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const n = v.narrative && typeof v.narrative === "object" ? v.narrative as Record<string, unknown> : {};
  const at = n.generatedAt ?? v.generatedAt;
  const notes = Array.isArray(v.coverageNotes) ? v.coverageNotes.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  return {
    generatedAt: typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null,
    notes: notes.length ? notes : ["Cakupan Profil Perseroan belum dapat dipastikan. Muat ulang hasil tersimpan sebelum mengekspor."],
  };
}

export function NarrativeCoverageNotice({ notice }: { notice: NarrativeNotice }) {
  return <div role="status" style={{ fontSize: 13, background: "#fffbeb", padding: 10, borderRadius: 6 }}>
    <strong>Cakupan Profil Perseroan</strong>
    {notice.generatedAt && <div>Hasil tersimpan: {new Date(notice.generatedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB.</div>}
    <ul>{notice.notes.map((text, i) => <li key={i}>{text}</li>)}</ul>
  </div>;
}

/** The actual caller's stream consumer; a completed HTTP response alone is not success. */
export async function consumeNarrativeStream(
  res: Response, onStep: (text: string) => void, onNotice: (notice: NarrativeNotice) => void,
  onPrevious: (generatedAt: string) => void,
) {
  if (!res.body) throw new Error("Hasil Profil Perseroan tidak tersedia");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", sawDone = false;
  const accept = (line: string) => {
    const msg = JSON.parse(line);
    if (msg.type === "step") onStep(msg.message);
    if (msg.type === "done") { sawDone = true; onNotice(narrativeNoticeFromResponse(msg)); }
    if (msg.type === "error") {
      if (typeof msg.previousGeneratedAt === "string" && Number.isFinite(Date.parse(msg.previousGeneratedAt))) onPrevious(msg.previousGeneratedAt);
      throw new Error(msg.message);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) accept(line);
    }
    buf += dec.decode();
    if (buf.trim()) accept(buf);
  } finally { await reader.cancel(); }
  if (!sawDone) throw new Error("Stream profil terputus sebelum selesai");
}

export default function DDStage5Review() {
  const { state, dispatch, setReviewNavigationGuard } = useDD();
  const [findingsByEntity, setFindingsByEntity] = useState<Record<string, DDFinding[]>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [narrativeNotices, setNarrativeNotices] = useState<Record<string, NarrativeNotice>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [consolidated, setConsolidated] = useState<DDConsolidated | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  // Per-entity save feedback: reviewer decisions auto-save on a debounce, so
  // without a visible status the "Simpan review" button looks like a no-op.
  const [saveStatus, setSaveStatus] = useState<Record<string, SaveStatus>>({});
  const [savedAt, setSavedAt] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ entityId: string; sourceFile: string; verbatim: string } | null>(null);
  const t = state.transaction;

  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const editingRef = useRef(new Set<string>());
  const [, refreshEditing] = useState(0);
  const queueRef = useRef<FindingsSaveQueue | null>(null);
  if (!queueRef.current || queueRef.current.sessionId !== state.sessionId) {
    queueRef.current?.dispose();
    queueRef.current = new FindingsSaveQueue(state.sessionId, (eid, draft) => {
      setDrafts(p => ({ ...p, [eid]: draft }));
      setFindingsByEntity(p => ({ ...p, [eid]: draft.findings }));
      setSaveStatus(p => ({ ...p, [eid]: draft.status }));
      if (draft.status === "saved") setSavedAt(p => ({ ...p, [eid]: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) }));
    });
  }
  const queue = queueRef.current;
  useEffect(() => {
    queue.activate();
    setFindingsByEntity({}); setDrafts({}); setSaveStatus({}); editingRef.current.clear();
    const blocked = () => queue.blocked() || editingRef.current.size > 0;
    setReviewNavigationGuard(blocked);
    const unload = (event: BeforeUnloadEvent) => { if (blocked()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    for (const e of t?.entities ?? []) void queue.load(e.id);
    return () => { setReviewNavigationGuard(null); window.removeEventListener("beforeunload", unload); queue.dispose(); };
    // Entity membership is fixed for this mounted review; a session change creates a new queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, setReviewNavigationGuard]);

  useEffect(() => {
    let current = true;
    for (const entity of t?.entities ?? []) {
      fetch(`/api/dd/narrative?sessionId=${encodeURIComponent(state.sessionId)}&entityId=${encodeURIComponent(entity.id)}`)
        .then((r) => r.ok ? r.json() : null)
        .then((value) => { if (current) setNarrativeNotices((p) => ({ ...p, [entity.id]: narrativeNoticeFromResponse(value) })); })
        .catch(() => { if (current) setNarrativeNotices((p) => ({ ...p, [entity.id]: narrativeNoticeFromResponse(null) })); });
    }
    return () => { current = false; };
  }, [state.sessionId, t]);

  // Re-hydrate a previously computed consolidation the same way findings are.
  // Self-healing: the boolean lives in sessionStorage (per-tab), so a new tab
  // would otherwise show "not consolidated" even though the blob exists.
  useEffect(() => {
    let current = true;
    fetch(`/api/dd/consolidate?sessionId=${state.sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!current || !d?.consolidated) return;
        setConsolidated((c) => c ?? d.consolidated);
        if (!state.consolidated) dispatch({ type: "SET_CONSOLIDATED", value: true });
      })
      .catch(() => {});
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sessionId]);

  if (!t) return <div>Selesaikan Stage 1 dahulu.</div>;

  // A one-company DD has nothing to consolidate ACROSS — the cross-entity step
  // is hidden for it and its aspect rollup runs automatically instead.
  const isSingleEntity = t.entities.length < 2;

  const analyze = async (eid: string) => {
    // Re-entrancy guard: prevent multiple concurrent analyses for the same entity
    if (running[eid] || editingRef.current.size > 0 || !queue.beginAnalysis(eid)) {
      dispatch({ type: "SET_ERROR", error: "Selesaikan review yang belum tersimpan atau muat ulang sebelum analisis." }); return;
    }

    setRunning((r) => ({ ...r, [eid]: true }));
    setProgress((p) => ({ ...p, [eid]: "Memulai…" }));
    try {
      const res = await fetch("/api/dd/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid }),
      });
      if (!queue.isActive()) { void res.body?.cancel(); return; }
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Gagal analisis");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let sawDone = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (!queue.isActive()) return;
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines.filter(Boolean)) {
            const msg = JSON.parse(line);
            if (msg.type === "step") setProgress((p) => ({ ...p, [eid]: msg.label }));
            if (msg.type === "done") {
              sawDone = true;
              queue.completeAnalysis(eid, msg);
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
      if (!queue.isActive()) return;
      dispatch({ type: "MARK_PROGRESS", entityId: eid, patch: { analyzed: true } });

      // BAB II Profil Perseroan is built here, and nothing used to build it: the
      // endpoint existed, narrative.ts and narrative-render.ts were written and
      // tested, and no code path called any of it. Every report shipped the chapter
      // as "tidak dapat disusun karena dokumen korporasi belum diperiksa".
      // tests/dd/api-wiring.test.ts is what keeps a route from going uncalled again.
      //
      // Sequential rather than parallel with the analysis: both routes run to
      // maxDuration = 300 and fan out model calls, and nothing here caps overall
      // concurrency yet.
      await runNarrative(eid);
      if (!queue.isActive()) return;

      // Single-entity DD: "cross-entity consolidation" is meaningless, but the
      // aspect rollup it computes still feeds the Word/Excel recap — and for one
      // entity it runs with NO model call at all. Run it silently so the report
      // is complete without making the lawyer click a confusing extra step.
      queue.endAnalysis(eid);
      if (isSingleEntity) void runConsolidate({ silent: true });
    } catch (err) {
      if (queue.isActive()) {
        queue.failAnalysis(eid);
        dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
      }
    } finally {
      if (queue.isActive()) { queue.endAnalysis(eid); setRunning((r) => ({ ...r, [eid]: false })); }
    }
  };

  const onAction = (eid: string) => (id: string, patch: Partial<DDFinding>) =>
    queue.edit(eid, id, patch);

  /**
   * Builds BAB II Profil Perseroan for one entity.
   *
   * Failure here is deliberately non-fatal but loud. The analysis has already been
   * persisted by the time this runs, so throwing it away would cost the expensive
   * work for the sake of the cheap. But a silent failure puts us straight back to
   * the defect being fixed — a report quietly missing its profile chapter — so the
   * lawyer is told that this attempt failed and an earlier artifact may remain.
   */
  const runNarrative = async (eid: string) => {
    if (!queue.isActive()) return;
    setProgress((p) => ({ ...p, [eid]: "Menyusun Profil Perseroan (Bab II)…" }));
    let previousGeneratedAt: string | null = null;
    try {
      const res = await fetch("/api/dd/narrative", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid }),
      });
      if (!queue.isActive()) { void res.body?.cancel(); return; }
      if (!res.ok || !res.body) {
        throw new Error((await res.json().catch(() => null))?.error ?? "Gagal menyusun Profil Perseroan");
      }
      await consumeNarrativeStream(res,
        (text) => { if (queue.isActive()) setProgress((p) => ({ ...p, [eid]: text })); },
        (notice) => {
          if (!queue.isActive()) return;
          setNarrativeNotices((p) => ({ ...p, [eid]: notice }));
          setProgress((p) => ({ ...p, [eid]: "Hasil penyusunan tersimpan — periksa catatan cakupan di bawah." }));
        },
        (at) => { previousGeneratedAt = at; },
      );
    } catch (err) {
      if (!queue.isActive()) return;
      dispatch({
        type: "SET_ERROR",
        error:
          `Analisis entitas selesai dan tersimpan, tetapi Profil Perseroan (Bab II) gagal disusun: ` +
          `${err instanceof Error ? err.message : "Penyusunan belum selesai"}. ` +
          (previousGeneratedAt
            ? `Hasil sebelumnya yang disimpan pada ${new Date(previousGeneratedAt).toLocaleString("id-ID")} tetap tersedia sebagai hasil terdahulu. `
            : "Jika sudah ada hasil yang tersimpan, hasil tersebut berasal dari penyusunan sebelumnya. ") +
          `Periksa catatan cakupannya dan jalankan ulang penyusunan sebelum mengekspor hasil terbaru.`,
      });
    }
  };

  // Explicit flush: bypasses the debounce timer and saves immediately,
  // regardless of the auto-persist effect's schedule.
  const saveReview = (eid: string) => {
    void queue.save(eid);
  };

  // opts.silent: the automatic single-entity rollup — a failure there must not
  // throw a scary banner at a lawyer who never asked for "consolidation"; the
  // export path already handles a missing rollup by omitting that section.
  const runConsolidate = async (opts?: { silent?: boolean }) => {
    if (!queue.isActive() || consolidating || queue.blocked() || editingRef.current.size > 0) return;
    setConsolidating(true);
    try {
      const res = await fetch("/api/dd/consolidate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
      const data = await res.json();
      if (!queue.isActive()) return;
      if (!res.ok) {
        if (!opts?.silent) dispatch({ type: "SET_ERROR", error: data.error });
        else console.error("[dd/stage5] rollup otomatis gagal:", data.error);
        return;
      }
      setConsolidated(data.consolidated);
      dispatch({ type: "SET_CONSOLIDATED", value: true });
    } catch (err) {
      if (!queue.isActive()) return;
      const message = err instanceof Error ? err.message : "Gagal konsolidasi";
      if (!opts?.silent) dispatch({ type: "SET_ERROR", error: message });
      else console.error("[dd/stage5] rollup otomatis gagal:", message);
    } finally {
      if (queue.isActive()) setConsolidating(false);
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
    if (queue.blocked() || editingRef.current.size > 0) {
      dispatch({ type: "SET_ERROR", error: "Selesaikan penyimpanan review sebelum mengekspor." }); return;
    }
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
              <button onClick={() => analyze(e.id)} disabled={running[e.id] || queue.blocked() || editingRef.current.size > 0 || saveStatus[e.id] === "conflict" || saveStatus[e.id] === "failed"}>{running[e.id] ? "Menganalisis…" : "Jalankan analisis"}</button>
              <button onClick={() => saveReview(e.id)} disabled={!drafts[e.id]?.dirty || saveStatus[e.id] === "conflict" || drafts[e.id]?.loading || running[e.id]}>Simpan review</button>
            </div>
          </div>
          {drafts[e.id]?.message && <div role="alert" style={{ color: "var(--error)", fontSize: 13 }}>{drafts[e.id].message}</div>}
          {(drafts[e.id]?.dirty || saveStatus[e.id] === "failed" || saveStatus[e.id] === "conflict") && (
            <button disabled={drafts[e.id]?.loading || running[e.id] || saveStatus[e.id] === "pending" || editingRef.current.size > 0}
              onClick={() => { void queue.load(e.id, true); }}>Buang draft lokal dan muat ulang temuan tersimpan</button>
          )}
          {progress[e.id] && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{progress[e.id]}</div>}
          {narrativeNotices[e.id] && <NarrativeCoverageNotice notice={narrativeNotices[e.id]} />}
          <div style={{ display: "grid", gap: 8 }}>
            {sortFindings(findingsByEntity[e.id] ?? []).map((f) => (
              <FindingCard
                key={f.id} f={f} onAction={onAction(e.id)} readOnly={running[e.id] || drafts[e.id]?.loading}
                onEditingChange={(value) => { const key = `${e.id}/${f.id}`; if (value) editingRef.current.add(key); else editingRef.current.delete(key); refreshEditing(v => v + 1); }}
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
