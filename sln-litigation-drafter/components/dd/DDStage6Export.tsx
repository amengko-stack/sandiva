"use client";

import { useState } from "react";
import { useDD } from "@/context/DDContext";

export default function DDStage6Export() {
  const { state, dispatch } = useDD();
  const [folderPath, setFolderPath] = useState(state.transaction?.entities[0]?.dataRoomPath ?? "");
  const [saving, setSaving] = useState(false);
  const [savedFiles, setSavedFiles] = useState<string[]>([]);
  const t = state.transaction;
  if (!t) return <div>Selesaikan Stage 1 dahulu.</div>;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/dd/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, folderPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Gagal menyimpan");
      setSavedFiles(data.files);
      dispatch({ type: "SET_SAVED", value: true });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 640 }}>
      <h1>6 — Ekspor</h1>
      <a href={`/api/dd/docx?sessionId=${state.sessionId}`} download style={{ padding: 12, border: "1px solid var(--border-color)", borderRadius: 8 }}>
        ⬇ Unduh Laporan Temuan (Word)
      </a>
      <a href={`/api/dd/excel?sessionId=${state.sessionId}`} download style={{ padding: 12, border: "1px solid var(--border-color)", borderRadius: 8 }}>
        ⬇ Unduh Indeks & Matriks Gap (Excel)
      </a>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
        Data sesi analisis tersimpan 24 jam — simpan hasil ke SharePoint sebelum mengakhiri hari kerja.
      </div>
      <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
        <strong>Simpan ke SharePoint (folder matter)</strong>
        <input value={folderPath} onChange={(e) => setFolderPath(e.target.value)} placeholder="Folder matter di SharePoint" style={{ padding: 8, border: "1px solid var(--border-color)", borderRadius: 6, background: "var(--bg-surface)", color: "var(--text-primary)" }} />
        <button onClick={save} disabled={saving || !folderPath.trim()} style={{ padding: 10, fontWeight: 600 }}>
          {saving ? "Menyimpan…" : "Simpan kedua file ke folder AI/"}
        </button>
        {savedFiles.length > 0 && (
          <div style={{ color: "var(--success)", fontSize: 13 }}>Tersimpan: {savedFiles.join(" · ")}</div>
        )}
      </div>
      <button onClick={() => { if (confirm("Mulai matter uji tuntas baru?")) dispatch({ type: "RESET" }); }}>
        Mulai matter baru
      </button>
    </div>
  );
}
