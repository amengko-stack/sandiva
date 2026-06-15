"use client";

import { useState, useEffect } from "react";
import type { JurisprudenceEntry } from "@/types";

export default function JurisprudenceManager() {
  const [entries, setEntries] = useState<JurisprudenceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState("");

  // Upload section state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [jsonInput, setJsonInput] = useState("");
  const [parsedEntries, setParsedEntries] = useState<JurisprudenceEntry[] | null>(null);
  const [parseError, setParseError] = useState("");

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

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setUploadedFile(file);
    setParsedEntries(null);
    setParseError("");
  }

  function parseJson() {
    setParseError("");
    setParsedEntries(null);
    try {
      const raw = jsonInput.trim();
      if (!raw) {
        setParseError("Tempel JSON entri yurisprudensi di atas.");
        return;
      }
      let parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) parsed = [parsed];
      // Basic validation
      const validated: JurisprudenceEntry[] = parsed.map((item: Record<string, unknown>, idx: number) => {
        if (typeof item.nomor !== "string" || !item.nomor)
          throw new Error(`Entri ${idx + 1}: field 'nomor' wajib dan harus berupa string`);
        if (typeof item.kaidah !== "string" || !item.kaidah)
          throw new Error(`Entri ${idx + 1}: field 'kaidah' wajib dan harus berupa string`);
        return {
          id: item.id as string || `juris_${Date.now()}_${idx}`,
          nomor: item.nomor as string,
          tahun: Number(item.tahun) || 0,
          topik: Array.isArray(item.topik) ? item.topik as string[] : [],
          kaidah: item.kaidah as string,
          pasal_terkait: Array.isArray(item.pasal_terkait) ? item.pasal_terkait as string[] : [],
          forum: (item.forum as string) || "",
          sumber_file: (item.sumber_file as string) || uploadedFile?.name || "",
          tipe_sumber: ((item.tipe_sumber as string) || "pdf") as "pdf" | "docx" | "doc",
          verified: true,
          addedAt: new Date().toISOString(),
        };
      });
      setParsedEntries(validated);
    } catch (e: unknown) {
      setParseError(e instanceof Error ? e.message : "JSON tidak valid");
    }
  }

  async function saveEntries() {
    if (!parsedEntries || parsedEntries.length === 0) return;
    setSaving(true);
    setSaveError("");
    setSaveSuccess("");
    try {
      let sourceFile: { name: string; base64: string; mime: string } | undefined;
      if (uploadedFile) {
        const buf = await uploadedFile.arrayBuffer();
        const uint8 = new Uint8Array(buf);
        const base64 = btoa(Array.from(uint8).map((b) => String.fromCharCode(b)).join(""));
        sourceFile = {
          name: uploadedFile.name,
          base64,
          mime: uploadedFile.type || "application/octet-stream",
        };
      }
      const res = await fetch("/api/jurisprudence/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: parsedEntries, sourceFile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menyimpan");
      setSaveSuccess(`${parsedEntries.length} entri disimpan. Total database: ${data.total} entri.`);
      setParsedEntries(null);
      setJsonInput("");
      setUploadedFile(null);
      await loadEntries();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setSaving(false);
    }
  }

  async function deleteEntry(id: string) {
    if (!confirm("Hapus entri ini dari database?")) return;
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
      setError(e instanceof Error ? e.message : "Gagal menghapus entri");
    }
  }

  return (
    <div>
      {/* Upload section */}
      <div style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
          Tambah Yurisprudensi
        </h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>
          Upload dokumen sumber (PDF/DOCX), lalu tempel JSON entri yurisprudensi yang diekstrak dari dokumen tersebut.
        </p>

        <div style={{ border: "1px solid var(--border-color)", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ padding: "10px 16px", background: "rgba(0,139,139,0.08)", borderBottom: "1px solid var(--border-color)" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#008B8B", letterSpacing: "0.08em" }}>LANGKAH 1 — UPLOAD DOKUMEN SUMBER (OPSIONAL)</span>
          </div>
          <div style={{ padding: "14px 16px" }}>
            <input
              type="file"
              accept=".pdf,.docx,.doc"
              onChange={handleFileChange}
              style={{ fontSize: 13 }}
            />
            {uploadedFile && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#008B8B" }}>
                ✓ {uploadedFile.name} ({Math.round(uploadedFile.size / 1024)} KB)
              </div>
            )}
          </div>
        </div>

        <div style={{ border: "1px solid var(--border-color)", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ padding: "10px 16px", background: "rgba(0,139,139,0.08)", borderBottom: "1px solid var(--border-color)" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#008B8B", letterSpacing: "0.08em" }}>LANGKAH 2 — TEMPEL JSON ENTRI</span>
          </div>
          <div style={{ padding: "14px 16px" }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
              Format: array JSON dengan field: <code>nomor</code>, <code>tahun</code>, <code>topik</code>, <code>kaidah</code>, <code>pasal_terkait</code>, <code>forum</code>
            </p>
            <textarea
              value={jsonInput}
              onChange={(e) => { setJsonInput(e.target.value); setParsedEntries(null); setParseError(""); }}
              rows={8}
              placeholder={`[\n  {\n    "nomor": "123 K/Pdt/2020",\n    "tahun": 2020,\n    "topik": ["wanprestasi", "kontrak"],\n    "kaidah": "...",\n    "pasal_terkait": ["Pasal 1243 KUHPerdata"],\n    "forum": "Mahkamah Agung"\n  }\n]`}
              style={{ fontSize: 12, fontFamily: "monospace", width: "100%", resize: "vertical" }}
            />
            {parseError && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--error)" }}>{parseError}</div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button
                onClick={parseJson}
                disabled={!jsonInput.trim()}
                style={{ padding: "7px 16px", background: "rgba(0,139,139,0.15)", border: "1px solid #008B8B", borderRadius: 4, color: "#008B8B", fontSize: 13, cursor: !jsonInput.trim() ? "not-allowed" : "pointer", opacity: !jsonInput.trim() ? 0.5 : 1 }}
              >
                Validasi JSON
              </button>
            </div>
          </div>
        </div>

        {/* Parsed entries preview */}
        {parsedEntries && parsedEntries.length > 0 && (
          <div style={{ border: "1px solid #008B8B", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ padding: "10px 16px", background: "rgba(0,139,139,0.1)", borderBottom: "1px solid #008B8B" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#008B8B", letterSpacing: "0.08em" }}>
                LANGKAH 3 — TINJAU {parsedEntries.length} ENTRI SEBELUM SIMPAN
              </span>
            </div>
            <div style={{ padding: "14px 16px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
                {parsedEntries.map((entry, i) => (
                  <EntryCard key={i} entry={entry} />
                ))}
              </div>
              {saveError && (
                <div style={{ padding: "8px 12px", background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 12, marginBottom: 10 }}>
                  {saveError}
                </div>
              )}
              {saveSuccess && (
                <div style={{ padding: "8px 12px", background: "rgba(39,174,96,0.1)", border: "1px solid var(--success)", borderRadius: 4, color: "var(--success)", fontSize: 12, marginBottom: 10 }}>
                  ✓ {saveSuccess}
                </div>
              )}
              <button
                onClick={saveEntries}
                disabled={saving}
                style={{ padding: "8px 20px", background: "#008B8B", color: "white", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: saving ? "wait" : "pointer" }}
              >
                {saving ? "Menyimpan..." : `Simpan ${parsedEntries.length} Entri ke Database →`}
              </button>
            </div>
          </div>
        )}

        {saveSuccess && !parsedEntries && (
          <div style={{ padding: "8px 12px", background: "rgba(39,174,96,0.1)", border: "1px solid var(--success)", borderRadius: 4, color: "var(--success)", fontSize: 12, marginBottom: 10 }}>
            ✓ {saveSuccess}
          </div>
        )}
      </div>

      {/* Database view */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
            Database Yurisprudensi
            {!loading && <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>({entries.length} entri)</span>}
          </h3>
          <button
            onClick={loadEntries}
            disabled={loading}
            style={{ fontSize: 12, color: "#008B8B", background: "none", border: "none", cursor: "pointer" }}
          >
            {loading ? "Memuat..." : "↻ Muat Ulang"}
          </button>
        </div>

        {error && (
          <div style={{ padding: "8px 12px", background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 14 }}>
            {error}
          </div>
        )}

        {loading && (
          <div style={{ padding: 16, fontSize: 13, color: "var(--text-muted)" }}>Memuat database...</div>
        )}

        {!loading && entries.length === 0 && (
          <div style={{ padding: 16, fontSize: 13, color: "var(--text-muted)", background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 4 }}>
            Database kosong. Tambahkan yurisprudensi di atas.
          </div>
        )}

        {!loading && entries.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {entries.map((entry) => (
              <div
                key={entry.id}
                style={{ background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 6, overflow: "hidden" }}
              >
                <div style={{ padding: "10px 16px", display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
                      {entry.nomor}
                      {entry.tahun > 0 && <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>({entry.tahun})</span>}
                      <span style={{ marginLeft: 8, fontSize: 11, padding: "1px 6px", borderRadius: 8, background: "rgba(0,139,139,0.12)", color: "#008B8B", fontWeight: 500 }}>
                        {entry.forum}
                      </span>
                    </div>
                    {entry.topik.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                        {entry.topik.map((t, i) => (
                          <span key={i} style={{ fontSize: 11, padding: "1px 8px", borderRadius: 10, background: "rgba(0,139,139,0.08)", color: "#008B8B", border: "1px solid rgba(0,139,139,0.2)" }}>
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                      {entry.kaidah.slice(0, 200)}{entry.kaidah.length > 200 ? "…" : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteEntry(entry.id)}
                    title="Hapus entri"
                    style={{ flexShrink: 0, padding: "4px 10px", background: "transparent", border: "1px solid rgba(192,57,43,0.3)", borderRadius: 4, color: "#c0392b", fontSize: 11, cursor: "pointer" }}
                  >
                    Hapus
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EntryCard({ entry }: { entry: JurisprudenceEntry }) {
  return (
    <div style={{ padding: "10px 14px", background: "rgba(0,139,139,0.04)", border: "1px solid rgba(0,139,139,0.2)", borderRadius: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
        {entry.nomor} — {entry.forum}
      </div>
      {entry.topik.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
          Topik: {entry.topik.join(", ")}
        </div>
      )}
      <div style={{ fontSize: 12, color: "var(--text-primary)", lineHeight: 1.5 }}>
        {entry.kaidah.slice(0, 150)}{entry.kaidah.length > 150 ? "…" : ""}
      </div>
    </div>
  );
}
