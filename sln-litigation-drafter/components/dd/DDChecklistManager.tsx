"use client";

import { useEffect, useState } from "react";
import { aspectLabel } from "@/config/ddAspects";
import type { ResolvedChecklist } from "@/types/dd";

// Read-only checklist view + template regeneration. The checklist itself is
// edited by the lawyer directly in SLN-AI/due-diligence/checklist.xlsx.
export default function DDChecklistManager({ onClose }: { onClose: () => void }) {
  const [checklist, setChecklist] = useState<ResolvedChecklist | null>(null);
  const [source, setSource] = useState<string>("");
  const [msg, setMsg] = useState<string>("");

  const load = () =>
    fetch("/api/dd/checklist?txn=akuisisi_saham")
      .then((r) => r.json())
      .then((d) => { if (d.checklist) { setChecklist(d.checklist); setSource(d.source); } else setMsg(d.error); })
      .catch((e) => setMsg(String(e)));

  useEffect(() => { load(); }, []);

  const generate = async () => {
    setMsg("Membuat template…");
    const res = await fetch("/api/dd/checklist", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "generate-template" }),
    });
    const d = await res.json();
    setMsg(res.ok ? "Template checklist.xlsx dibuat di SLN-AI/due-diligence/ — edit langsung di SharePoint." : d.error);
    load();
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 60, display: "flex", justifyContent: "center", padding: 40 }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 20, maxWidth: 720, width: "100%", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h2 style={{ marginTop: 0 }}>Checklist Uji Tuntas ({source === "sharepoint" ? "dari SharePoint" : "bawaan (seed)"})</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: "#6b7280" }}>
          Checklist diedit langsung di <code>SLN-AI/due-diligence/checklist.xlsx</code> di SharePoint — aplikasi membaca versi terbaru setiap dijalankan.
        </p>
        <button onClick={generate}>Buat/perbarui template di SharePoint (dari seed)</button>
        {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
        {checklist && (
          <table style={{ fontSize: 12, borderCollapse: "collapse", width: "100%" }}>
            <thead><tr><th style={{ textAlign: "left" }}>Aspek</th><th style={{ textAlign: "left" }}>Dokumen</th><th>Kepentingan</th></tr></thead>
            <tbody>
              {checklist.expected.map((d) => (
                <tr key={d.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: 4 }}>{aspectLabel(d.aspectId)}</td>
                  <td style={{ padding: 4 }}>{d.label}</td>
                  <td style={{ padding: 4, textAlign: "center" }}>{d.importance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
