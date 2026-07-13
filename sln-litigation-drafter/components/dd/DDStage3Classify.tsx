"use client";

import { useState } from "react";
import { useDD } from "@/context/DDContext";
import DDGapMatrix from "@/components/dd/DDGapMatrix";
import type { DDClassifiedDoc, DDGapItem, DDTailorResult } from "@/types/dd";

interface EntityRun {
  running: boolean;
  progress: string;
  classified: DDClassifiedDoc[];
  tailored: DDTailorResult | null;
  gaps: DDGapItem[];
  warnings: string[];
}

const EMPTY_RUN: EntityRun = { running: false, progress: "", classified: [], tailored: null, gaps: [], warnings: [] };

export default function DDStage3Classify() {
  const { state, dispatch } = useDD();
  const [runs, setRuns] = useState<Record<string, EntityRun>>({});
  const t = state.transaction;
  if (!t) return <div>Selesaikan Stage 1 dahulu.</div>;

  const patch = (eid: string, p: Partial<EntityRun>) =>
    setRuns((r) => ({ ...r, [eid]: { ...EMPTY_RUN, ...(r[eid] ?? {}), ...p } }));

  const runEntity = async (eid: string) => {
    patch(eid, { running: true, progress: "Menyimpan transaksi…", warnings: [] });
    try {
      // 1) persist the transaction so server routes can read it
      let res = await fetch("/api/dd/gaps", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-transaction", transaction: t }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Gagal menyimpan transaksi");

      // 2) classify (NDJSON stream)
      patch(eid, { progress: "Klasifikasi dokumen…" });
      res = await fetch("/api/dd/classify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Gagal klasifikasi");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let docs: DDClassifiedDoc[] = [];
      let sawDone = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const msg = JSON.parse(line);
          if (msg.type === "doc") patch(eid, { progress: `Klasifikasi ${msg.index + 1}/${msg.total}: ${msg.doc.fileName}` });
          if (msg.type === "warning")
            setRuns((r) => ({
              ...r,
              [eid]: { ...EMPTY_RUN, ...(r[eid] ?? {}), warnings: [...(r[eid]?.warnings ?? []), msg.message] },
            }));
          if (msg.type === "done") {
            docs = msg.docs;
            sawDone = true;
          }
          if (msg.type === "error") throw new Error(msg.message);
        }
      }
      if (!sawDone) throw new Error("Stream klasifikasi terputus sebelum selesai — jalankan ulang entitas ini.");
      patch(eid, { classified: docs });

      // 3) tailor
      patch(eid, { progress: "Menyesuaikan checklist dengan sektor…" });
      res = await fetch("/api/dd/tailor", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid }),
      });
      const tailorData = await res.json();
      if (!res.ok) throw new Error(tailorData.error ?? "Gagal tailoring");

      // 4) gaps
      patch(eid, { progress: "Menghitung gap…", tailored: tailorData.tailored });
      res = await fetch("/api/dd/gaps", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "compute", sessionId: state.sessionId, entityId: eid }),
      });
      const gapData = await res.json();
      if (!res.ok) throw new Error(gapData.error ?? "Gagal menghitung gap");
      patch(eid, { gaps: gapData.gaps, progress: "Selesai" });
      dispatch({ type: "MARK_PROGRESS", entityId: eid, patch: { classified: true } });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
      patch(eid, { progress: "Gagal" });
    } finally {
      patch(eid, { running: false });
    }
  };

  const allDone = t.entities.every((e) => state.progress[e.id]?.classified);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1>3 — Klasifikasi & Analisis Gap</h1>
      {t.entities.map((e) => {
        const run = runs[e.id];
        return (
          <div key={e.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>{e.name}</strong>
              <button onClick={() => runEntity(e.id)} disabled={run?.running || !state.progress[e.id]?.extracted}>
                {run?.running ? "Berjalan…" : "Klasifikasi + Gap"}
              </button>
            </div>
            {run?.progress && <div style={{ fontSize: 13, color: "#6b7280" }}>{run.progress}</div>}
            {run?.warnings && run.warnings.length > 0 && (
              <div style={{ fontSize: 13, background: "#fefce8", padding: 8, borderRadius: 6 }}>
                {run.warnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}
            {run?.tailored && run.tailored.added.length > 0 && (
              <div style={{ fontSize: 13, background: "#eff6ff", padding: 8, borderRadius: 6 }}>
                Checklist ditambah (AI): {run.tailored.added.map((d) => d.label).join("; ")}
              </div>
            )}
            {run?.tailored && run.tailored.notApplicableSuggestions.length > 0 && (
              <div style={{ fontSize: 13, background: "#fefce8", padding: 8, borderRadius: 6 }}>
                Disarankan tidak relevan: {run.tailored.notApplicableSuggestions.map((s) => `${s.expectedDocId} (${s.reason})`).join("; ")}
              </div>
            )}
            {run?.gaps && run.gaps.length > 0 && <DDGapMatrix gaps={run.gaps} />}
          </div>
        );
      })}
      <button onClick={() => dispatch({ type: "SET_STAGE", stage: 4 })} disabled={!allDone} style={{ padding: 12, fontWeight: 600 }}>
        Lanjut ke Tabel Ketentuan Kunci →
      </button>
    </div>
  );
}
