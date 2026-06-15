"use client";

import { useState, useEffect } from "react";
import type { JurisprudenceEntry } from "@/types";

export default function JurisprudenceManager() {
  const [entries, setEntries] = useState<JurisprudenceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Upload / add section state
  const [file, setFile] = useState<File | null>(null);
  const [jsonInput, setJsonInput] = useState("");
  const [parsedEntries, setParsedEntries] = useState<JurisprudenceEntry[] | null>(null);
  const [parseError, setParseError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState("");

  // Delete state
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    loadEntries();
  }, []);

  async function loadEntries() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/jurisprudence/list");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal memuat database");
      setEntries(data.entries ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setLoading(false);
    }
  }

  function parseJson() {
    setParseError("");
    setParsedEntries(null);
    try {
      const raw = jsonInput.trim();
      if (!raw) {
        setParseError("JSON kosong");
        return;
      }
      const parsed = JSON.parse(raw);
      const arr: JurisprudenceEntry[] = Array.isArray(parsed) ? parsed : [parsed];
      // Basic validation
      for (const e of arr) {
        if (!e.id || !e.nomor || !e.kaidah) {
          setParseError("Setiap entri harus memiliki id, nomor, dan kaidah");
          return;
        }
      }
      setParsedEntries(arr);
    } catch {
      setParseError("Format JSON tidak valid");
    }
  }

  async function saveEntries() {
    if (!parsedEntries) return;
    setSaving(true);
    setSaveSuccess("");
    setError("");
    try {
      let sourceFile: { name: string; base64: string; mime: string } | undefined;
      if (file) {
        const buf = await file.arrayBuffer();
        const base64 = Buffer.from(buf).toString("base64");
        sourceFile = { name: file.name, base64, mime: file.type || "application/octet-stream" };
      }
      const res = await fetch("/api/jurisprudence/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: parsedEntries, sourceFile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menyimpan");
      setSaveSuccess(`${parsedEntries.length} entri berhasil disimpan. Total database: ${data.total}`);
      setParsedEntries(null);
      setJsonInput("");
      setFile(null);
      await loadEntries();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setSaving(false);
    }
  }

  async function deleteEntry(id: string) {
    setDeletingId(id);
    setError("");
    try {
      const res = await fetch("/api/jurisprudence/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menghapus");
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
        Kelola Yurisprudensi
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 28 }}>
        Tambah, tinjau, dan hapus entri yurisprudensi dari database SLN. Entri yang tersimpan akan otomatis dipertimbangkan saat penyusunan draf.
      </p>

      {error && (
        <div style={{ padding: 12, background: "rgba(192,57,43,0.1)", border: "1px solid #c0392b", borderRadius: 4, color: "#c0392b", fontSize: 13, marginBottom: 20 }}>
          {error}
        </div>
      )}

      {saveSuccess && (
        <div style={{ padding: 12, background: "rgba(22,160,133,0.1)", border: "1px solid #16a085", borderRadius: 4, color: "#16a085", fontSize: 13, marginBottom: 20 }}>
          ✓ {saveSuccess}
        </div>
      )}

      {/* Upload section */}
      <div style={{ border: "1px solid #1a5f57", borderRadius: 6, marginBottom: 32, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", background: "rgba(22,160,133,0.08)", borderBottom: "1px solid #1a5f57" }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", color: "#16a085" }}>
            TAMBAH ENTRI BARU
          </div>
        </div>
        <div style={{ padding: "16px 20px" }}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 6 }}>
              File Sumber (PDF/DOCX) — opsional
            </label>
            <input
              type="file"
              accept=".pdf,.docx,.doc"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: 13, color: "var(--text-primary)" }}
            />
            {file && (
              <div style={{ fontSize: 12, color: "#16a085", marginTop: 4 }}>✓ {file.name}</div>
            )}
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 6 }}>
              JSON Entri Yurisprudensi
            </label>
            <textarea
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              rows={8}
              placeholder={`[\n  {\n    "id": "uuid-unik",\n    "nomor": "123 K/Pdt/2020",\n    "tahun": 2020,\n    "topik": ["wanprestasi", "kontrak"],\n    "kaidah": "Ingkar janji harus dibuktikan...",\n    "pasal_terkait": ["Pasal 1243 KUHPerdata"],\n    "forum": "Mahkamah Agung",\n    "sumber_file": "putusan_123.pdf",\n    "tipe_sumber": "pdf",\n    "verified": true,\n    "addedAt": "2024-01-01T00:00:00.000Z"\n  }\n]`}
              style={{ fontSize: 12, fontFamily: "monospace", lineHeight: 1.5 }}
            />
            {parseError && (
              <div style={{ fontSize: 12, color: "#c0392b", marginTop: 4 }}>{parseError}</div>
            )}
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={parseJson}
              disabled={!jsonInput.trim()}
              style={{ padding: "8px 18px", background: "transparent", border: "1px solid #16a085", borderRadius: 4, color: "#16a085", fontSize: 13, cursor: !jsonInput.trim() ? "not-allowed" : "pointer", opacity: !jsonInput.trim() ? 0.5 : 1 }}
            >
              Validasi JSON
            </button>
            {parsedEntries && (
              <button
                onClick={saveEntries}
                disabled={saving}
                style={{ padding: "8px 18px", background: "#16a085", border: "none", borderRadius: 4, color: "white", fontSize: 13, fontWeight: 500, cursor: saving ? "wait" : "pointer" }}
              >
                {saving ? "Menyimpan..." : `Simpan ${parsedEntries.length} Entri`}
              </button>
            )}
          </div>

          {/* Preview parsed entries */}
          {parsedEntries && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#16a085", marginBottom: 10 }}>
                PRATINJAU — {parsedEntries.length} ENTRI
              </div>
              {parsedEntries.map((e, i) => (
                <EntryCard key={i} entry={e} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Database view */}
      <div style={{ border: "1px solid var(--border-color)", borderRadius: 6, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", background: "var(--bg-sidebar)", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", color: "var(--text-muted)" }}>
            DATABASE YURISPRUDENSI
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {loading ? "Memuat..." : `${entries.length} entri`}
          </div>
        </div>
        <div style={{ padding: "16px 20px" }}>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 16 }}>
              <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid var(--border-color)", borderTopColor: "#16a085", animation: "spin 0.8s linear infinite" }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Memuat database...</span>
            </div>
          )}
          {!loading && entries.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, fontStyle: "italic" }}>
              Database kosong. Tambahkan entri pertama di atas.
            </p>
          )}
          {!loading && entries.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {entries.map((e) => (
                <div key={e.id} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <EntryCard entry={e} />
                  </div>
                  <button
                    onClick={() => deleteEntry(e.id)}
                    disabled={deletingId === e.id}
                    title="Hapus entri ini"
                    style={{ marginTop: 10, padding: "4px 10px", background: "transparent", border: "1px solid rgba(192,57,43,0.4)", borderRadius: 4, color: "#c0392b", fontSize: 12, cursor: deletingId === e.id ? "wait" : "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
                  >
                    {deletingId === e.id ? "..." : "Hapus"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EntryCard({ entry }: { entry: JurisprudenceEntry }) {
  return (
    <div style={{ padding: "12px 14px", background: "var(--bg-surface)", border: "1px solid #1a5f57", borderRadius: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#16a085" }}>{entry.nomor}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{entry.forum} · {entry.tahun}</span>
        {entry.verified && (
          <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: "rgba(22,160,133,0.15)", color: "#16a085", fontWeight: 600 }}>
            TERVERIFIKASI
          </span>
        )}
      </div>
      {entry.topik.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          {entry.topik.map((t: string, i: number) => (
            <span key={i} style={{ fontSize: 11, padding: "2px 7px", borderRadius: 8, background: "rgba(22,160,133,0.08)", color: "#16a085", border: "1px solid rgba(22,160,133,0.2)" }}>
              {t}
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--text-primary)", lineHeight: 1.6, marginBottom: entry.pasal_terkait.length > 0 ? 4 : 0 }}>
        {entry.kaidah}
      </div>
      {entry.pasal_terkait.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Pasal terkait: {entry.pasal_terkait.join(", ")}
        </div>
      )}
    </div>
  );
}
