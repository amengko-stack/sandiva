"use client";

import { useState } from "react";
import { useDD } from "@/context/DDContext";
import DDCoveragePanel from "@/components/dd/DDCoveragePanel";
import type { ExtractReport } from "@/types";

interface EntityRun { log: string[]; report: ExtractReport | null; running: boolean; done: boolean; }

export default function DDStage2Extract() {
  const { state, dispatch } = useDD();
  const [runs, setRuns] = useState<Record<string, EntityRun>>({});
  const t = state.transaction;
  if (!t) return <div>Selesaikan Stage 1 dahulu.</div>;

  const patch = (eid: string, p: Partial<EntityRun>) =>
    setRuns((r) => ({ ...r, [eid]: { ...(r[eid] ?? { log: [], report: null, running: false, done: false }), ...p } }));

  // Functional update — appending via a stale `runs` closure inside the SSE
  // read loop would drop log lines.
  const appendLog = (eid: string, entry: string) =>
    setRuns((r) => ({
      ...r,
      [eid]: { log: [...(r[eid]?.log ?? []), entry], report: r[eid]?.report ?? null, running: r[eid]?.running ?? true, done: r[eid]?.done ?? false },
    }));

  const extractEntity = async (eid: string) => {
    const entity = t.entities.find((e) => e.id === eid)!;
    patch(eid, { running: true, log: [] });
    try {
      const res = await fetch("/api/dd/extract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, entityId: eid, files: entity.files }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Gagal memulai ekstraksi");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const ev of events) {
          const line = ev.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const msg = JSON.parse(line.slice(6));
          if (msg.type === "done") appendLog(eid, `✓ ${msg.name} (${msg.charCount} kar)`);
          if (msg.type === "error") appendLog(eid, `✗ ${msg.name}: ${msg.reason}`);
          if (msg.type === "ocr_required") appendLog(eid, `⚠ ${msg.name}: perlu OCR`);
          if (msg.type === "complete") {
            patch(eid, { done: true });
            dispatch({ type: "MARK_PROGRESS", entityId: eid, patch: { extracted: true } });
          }
          if (msg.error) throw new Error(msg.error);
        }
      }
      // Pull the report for the coverage panel.
      const rep = await fetch(`/api/dd/check-session?sessionId=${state.sessionId}&entityId=${eid}&artifact=report`).then((r) => r.ok ? r.json() : null).catch(() => null);
      if (rep?.report) patch(eid, { report: rep.report });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      patch(eid, { running: false });
    }
  };

  const allDone = t.entities.every((e) => state.progress[e.id]?.extracted);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h1>2 — Ekstraksi Data Room</h1>
      {t.entities.map((e) => {
        const run = runs[e.id];
        return (
          <div key={e.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>{e.name}</strong>
              <button onClick={() => extractEntity(e.id)} disabled={run?.running}>
                {run?.running ? "Mengekstrak…" : state.progress[e.id]?.extracted ? "Ekstrak ulang" : "Mulai ekstraksi"}
              </button>
            </div>
            {run?.log && run.log.length > 0 && (
              <pre style={{ maxHeight: 160, overflowY: "auto", fontSize: 12, background: "#f9fafb", padding: 8 }}>{run.log.join("\n")}</pre>
            )}
            <DDCoveragePanel report={run?.report ?? null} />
          </div>
        );
      })}
      <button onClick={() => dispatch({ type: "SET_STAGE", stage: 3 })} disabled={!allDone} style={{ padding: 12, fontWeight: 600 }}>
        Lanjut ke Klasifikasi →
      </button>
    </div>
  );
}
