"use client";
import React, { useEffect, useRef, useState } from "react";
import type { JurisprudenceEntry } from "@/types";

export default function JurisprudenceManager() {
  const [dbEntries, setDbEntries] = useState<JurisprudenceEntry[]>([]);
  const [pendingEntries, setPendingEntries] = useState<JurisprudenceEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void loadDb(); }, []);

  async function loadDb() {
    try {
      const res = await fetch("/api/jurisprudence/list");
      const data = (await res.json()) as { entries: JurisprudenceEntry[] };
      setDbEntries(data.entries ?? []);
    } catch { /* silent */ }
  }

  async function handleUpload() {
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      const res = await fetch("/api/jurisprudence/parse", { method: "POST", body: form });
      const data = (await res.json()) as { entries?: JurisprudenceEntry[]; error?: string };
      if (data.error) { setError(data.error); return; }
      setPendingEntries(data.entries ?? []);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload gagal");
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    if (pendingEntries.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/jurisprudence/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: pendingEntries }),
      });
      const data = (await res.json()) as { total?: number; error?: string };
      if (data.error) { setError(data.error); return; }
      setSuccessMsg(`Tersimpan. Database SLN: ${data.total ?? 0} putusan terverifikasi.`);
      setPendingEntries([]);
      await loadDb();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simpan gagal");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await fetch("/api/jurisprudence/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await loadDb();
    } catch { /* silent */ }
  }

  function updateKaidah(id: string, kaidah: string) {
    setPendingEntries((prev) => prev.map((e) => (e.id === id ? { ...e, kaidah } : e)));
  }

  function removePending(id: string) {
    setPendingEntries((prev) => prev.filter((e) => e.id !== id));
  }

  const grouped = dbEntries.reduce<Record<string, JurisprudenceEntry[]>>((acc, e) => {
    const key = e.topik[0] ?? "Lainnya";
    (acc[key] = acc[key] ?? []).push(e);
    return acc;
  }, {});

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 800, margin: "0 auto", padding: "0 16px" }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Kelola Yurisprudensi</h2>

      <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 20, marginBottom: 24 }}>
        <p style={{ fontWeight: 600, marginBottom: 8 }}>Upload dokumen yurisprudensi</p>
        <p style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
          Indeks MA, putusan lengkap, atau kompilasi topik (.pdf, .doc, .docx)
        </p>
        <input ref={fileInputRef} type="file" multiple accept=".pdf,.doc,.docx" style={{ marginBottom: 12, display: "block" }} />
        <button
          onClick={() => void handleUpload()}
          disabled={uploading}
          style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "8px 18px", cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.7 : 1 }}
        >
          {uploading ? "Memproses..." : "Proses Dokumen"}
        </button>
      </div>

      {error && <p style={{ color: "#dc2626", marginBottom: 12 }}>{error}</p>}
      {successMsg && <p style={{ color: "#16a34a", marginBottom: 12 }}>{successMsg}</p>}

      {pendingEntries.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <p style={{ fontWeight: 600, marginBottom: 12 }}>
            Hasil Parsing — Tinjau sebelum menyimpan ({pendingEntries.length} putusan)
          </p>
          {pendingEntries.map((e) => (
            <div key={e.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, marginBottom: 12, position: "relative" }}>
              <button
                onClick={() => removePending(e.id)}
                style={{ position: "absolute", top: 12, right: 12, background: "none", border: "1px solid #ccc", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 12 }}
              >
                Hapus
              </button>
              <p style={{ fontWeight: 600, marginBottom: 6 }}>{e.nomor} ({e.tahun})</p>
              <textarea
                value={e.kaidah}
                onChange={(ev) => updateKaidah(e.id, ev.target.value)}
                rows={3}
                style={{ width: "100%", border: "1px solid #ccc", borderRadius: 4, padding: 8, fontSize: 13, resize: "vertical", boxSizing: "border-box" }}
              />
              <div style={{ fontSize: 12, color: "#555", marginTop: 6 }}>
                Topik: {e.topik.join(", ")} | Pasal: {e.pasal_terkait.join(", ")}
              </div>
            </div>
          ))}
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 6, padding: "8px 18px", cursor: saving ? "default" : "pointer", opacity: saving ? 0.7 : 1 }}
          >
            {saving ? "Menyimpan..." : "Simpan ke Database"}
          </button>
        </div>
      )}

      <div>
        <p style={{ fontWeight: 600, marginBottom: 12 }}>
          Database SLN: {dbEntries.length} putusan terverifikasi
        </p>
        {dbEntries.length === 0 && (
          <p style={{ color: "#888", fontSize: 13 }}>
            Belum ada putusan dalam database. Upload dokumen di atas untuk menambahkan.
          </p>
        )}
        {Object.entries(grouped).map(([topic, items]) => (
          <div key={topic} style={{ marginBottom: 16 }}>
            <p style={{ fontWeight: 600, fontSize: 13, color: "#1abc9c", marginBottom: 6 }}>
              {topic} ({items.length})
            </p>
            {items.map((e) => (
              <div
                key={e.id}
                style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 10, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}
              >
                <div style={{ flex: 1 }}>
                  <p style={{ fontWeight: 500, fontSize: 13, margin: 0 }}>{e.nomor}</p>
                  <p style={{ fontSize: 12, color: "#666", marginTop: 4, marginBottom: 0 }}>
                    {e.kaidah.slice(0, 150)}{e.kaidah.length > 150 ? "..." : ""}
                  </p>
                </div>
                <button
                  onClick={() => void handleDelete(e.id)}
                  style={{ background: "none", border: "1px solid #ccc", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontSize: 11, marginLeft: 12, flexShrink: 0 }}
                >
                  Hapus
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
