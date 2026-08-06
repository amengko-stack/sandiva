"use client";

import { useEffect, useState } from "react";
import { useDD } from "@/context/DDContext";

interface BaselineStatus {
  entityId: string;
  entityName: string;
  count: number;
  lastIssuedAtISO: string | null;
}

export default function DDStage6Export() {
  const { state, dispatch } = useDD();
  const [folderPath, setFolderPath] = useState(state.transaction?.entities[0]?.dataRoomPath ?? "");
  const [saving, setSaving] = useState(false);
  const [savedFiles, setSavedFiles] = useState<string[]>([]);
  const [baselines, setBaselines] = useState<BaselineStatus[] | null>(null);
  const [recording, setRecording] = useState(false);
  const t = state.transaction;

  // Which reports have been recorded as issued. Without one there is nothing for a
  // supplement to be a supplement TO, so the buttons below depend on it.
  useEffect(() => {
    let live = true;
    fetch(`/api/dd/baseline?sessionId=${state.sessionId}`)
      .then((r) => (r.ok ? r.json() : { entities: [] }))
      .then((d) => {
        if (live) setBaselines(d.entities ?? []);
      })
      .catch(() => {
        if (live) setBaselines([]);
      });
    return () => {
      live = false;
    };
  }, [state.sessionId, recording]);

  if (!t) return <div>Selesaikan Stage 1 dahulu.</div>;

  const recordIssue = async () => {
    setRecording(true);
    try {
      const res = await fetch("/api/dd/baseline", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Gagal mencatat penerbitan");
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Error" });
    } finally {
      setRecording(false);
    }
  };

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
        Data sesi uji tuntas dipertahankan 90 hari sejak aktivitas terakhir, agar satu matter dapat berjalan
        beberapa minggu. Tetap simpan hasil ke SharePoint sebagai arsip matter.
      </div>

      {/*
        Recording an issue is a decision, not a download, so it is a button rather
        than a side effect of exporting the Word file — an export link can be fired
        twice by a browser, and "this report went to the client" must not be.
      */}
      <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
        <strong>Laporan tambahan (supplement)</strong>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Setelah laporan diterbitkan kepada klien, catat penerbitannya. Ketika dokumen susulan diterima dan
          Tahap 2–5 dijalankan ulang, aplikasi dapat menyusun Laporan Tambahan yang memuat apa saja yang berubah
          sejak laporan tersebut — bukan mengulang laporannya.
        </div>
        {/*
          Stated because it is true and the lawyer needs it: the button records the
          CURRENT state, not the file that was downloaded. Nothing ties the two
          together, so re-running an analysis between the download and the click
          would record a state the client never received.
        */}
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Yang dicatat adalah keadaan analisis <strong>saat tombol ditekan</strong>, bukan berkas yang telah
          diunduh. Tekan segera setelah mengunduh laporan, dan jangan menjalankan ulang Tahap 2–5 di antaranya.
        </div>
        <button onClick={recordIssue} disabled={recording} style={{ padding: 10, fontWeight: 600 }}>
          {recording ? "Mencatat…" : "Catat penerbitan laporan hari ini"}
        </button>
        {baselines !== null && baselines.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            {baselines.map((b) => (
              <div key={b.entityId} style={{ fontSize: 13 }}>
                {b.count === 0 ? (
                  <span style={{ color: "var(--text-muted)" }}>
                    {b.entityName}: belum ada laporan yang tercatat diterbitkan.
                  </span>
                ) : (
                  <>
                    <span>
                      {b.entityName}: {b.count} penerbitan tercatat
                      {b.lastIssuedAtISO ? ` (terakhir ${b.lastIssuedAtISO.slice(0, 10)})` : ""}.
                    </span>{" "}
                    <a href={`/api/dd/supplement?sessionId=${state.sessionId}&entityId=${b.entityId}`} download>
                      ⬇ Unduh Laporan Tambahan
                    </a>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
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
