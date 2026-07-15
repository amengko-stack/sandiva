"use client";

import { useEffect, useState } from "react";
import { useDD, loadLastDDSession, type DDLastRecord } from "@/context/DDContext";
import DDStage1Setup from "@/components/dd/DDStage1Setup";
import DDStage2Extract from "@/components/dd/DDStage2Extract";
import DDStage3Classify from "@/components/dd/DDStage3Classify";
import DDStage4Tables from "@/components/dd/DDStage4Tables";
import DDStage5Review from "@/components/dd/DDStage5Review";
import DDStage6Export from "@/components/dd/DDStage6Export";

export default function DDPage() {
  const { state, dispatch } = useDD();
  const [last, setLast] = useState<DDLastRecord | null>(null);
  useEffect(() => {
    const rec = loadLastDDSession();
    if (rec && rec.sessionId !== state.sessionId && !state.transaction) setLast(rec);
    else setLast(null);
  }, [state.sessionId, state.transaction]);

  const resume = async () => {
    if (!last) return;
    try {
      const res = await fetch(`/api/dd/check-session?sessionId=${last.sessionId}`);
      const data = await res.json();
      if (!data.exists) { setLast(null); dispatch({ type: "SET_ERROR", error: "Sesi lama sudah kedaluwarsa (Blob 24 jam) — mulai baru." }); return; }
      dispatch({ type: "HYDRATE", state: {
        stage: 2, sessionId: last.sessionId, transaction: data.transaction, activeEntityId: null,
        progress: Object.fromEntries(Object.entries(data.entities as Record<string, Record<string, boolean>>).map(([id, e]) => [id, {
          extracted: e.extracted, classified: e.gaps, tabled: e.tables, analyzed: e.findings,
        }])),
        consolidated: false, savedToSharePoint: false, error: null,
      }});
      setLast(null);
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      {last && (
        <div style={{ background: "#eff6ff", color: "#1e3a8a", padding: 12, borderRadius: 8, marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Lanjutkan matter terakhir: <strong>{last.name}</strong> ({new Date(last.timestamp).toLocaleString("id-ID")})?</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={resume}>Lanjutkan</button>
            <button onClick={() => setLast(null)}>Abaikan</button>
          </div>
        </div>
      )}
      {state.error && (
        <div style={{ background: "#fee2e2", color: "#991b1b", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          {state.error}
        </div>
      )}
      {state.stage === 1 && <DDStage1Setup />}
      {state.stage === 2 && <DDStage2Extract />}
      {state.stage === 3 && <DDStage3Classify />}
      {state.stage === 4 && <DDStage4Tables />}
      {state.stage === 5 && <DDStage5Review />}
      {state.stage === 6 && <DDStage6Export />}
    </div>
  );
}
