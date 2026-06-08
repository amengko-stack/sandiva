"use client";

import { useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { FileEntry } from "@/types";

export default function Stage2Files() {
  const { state, dispatch, goToStage } = useWorkflow();
  const [folderLink, setFolderLink] = useState(state.folderPath || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const files: FileEntry[] = state.allFiles;
  const selectedCount = files.filter((f) => f.selected).length;

  async function loadFiles() {
    const link = folderLink.trim();
    if (!link) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/sharepoint/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: link }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Gagal memuat daftar file");
      if (!result.files?.length) throw new Error("Tidak ada dokumen (docx/pdf/doc/txt) ditemukan di folder ini.");
      dispatch({ type: "SET_FOLDER", folderPath: link });
      dispatch({ type: "SET_ALL_FILES", files: result.files });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setLoading(false);
    }
  }

  function toggleFile(id: string) {
    dispatch({ type: "TOGGLE_FILE", id });
  }

  function toggleAll(selected: boolean) {
    dispatch({ type: "SET_ALL_FILES", files: files.map((f) => ({ ...f, selected })) });
  }

  function handleProceed() {
    const selected = files.filter((f) => f.selected);
    if (selected.length === 0) {
      setError("Pilih minimal satu dokumen untuk dilanjutkan.");
      return;
    }
    dispatch({ type: "SET_SELECTED_FILES", files: selected });
    goToStage(3);
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
        Dokumen Perkara
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 32 }}>
        Masukkan sharing link folder SharePoint yang berisi dokumen perkara.
      </p>

      <div style={{ marginBottom: 24 }}>
        <label style={{ display: "block", fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
          Sharing Link Folder SharePoint
        </label>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            type="text"
            value={folderLink}
            onChange={(e) => { setFolderLink(e.target.value); setError(""); }}
            onKeyDown={(e) => e.key === "Enter" && loadFiles()}
            placeholder="https://sandiva.sharepoint.com/:f:/s/SiteName/AbCdEfGhIj..."
            style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }}
            disabled={loading}
          />
          <button
            onClick={loadFiles}
            disabled={loading || !folderLink.trim()}
            style={{
              padding: "8px 20px",
              background: "var(--accent-blue)",
              color: "white",
              border: "none",
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 500,
              cursor: loading || !folderLink.trim() ? "not-allowed" : "pointer",
              opacity: loading || !folderLink.trim() ? 0.6 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {loading ? "Memuat..." : "Muat Daftar"}
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
          Buka folder di SharePoint → klik <strong>Bagikan</strong> → salin link → tempel di sini.
        </p>
        {error && (
          <p style={{ color: "var(--error)", fontSize: 13, marginTop: 8 }}>{error}</p>
        )}
      </div>

      {files.length > 0 && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {files.length} dokumen ditemukan · {selectedCount} dipilih
            </span>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={() => toggleAll(true)}
                style={{ fontSize: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer" }}
              >
                Pilih Semua
              </button>
              <button
                onClick={() => toggleAll(false)}
                style={{ fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
              >
                Hapus Pilihan
              </button>
            </div>
          </div>

          <div style={{ border: "1px solid var(--border-color)", borderRadius: 4, maxHeight: 320, overflowY: "auto", marginBottom: 24 }}>
            {files.map((file, i) => (
              <FileRow
                key={file.id}
                file={file}
                isLast={i === files.length - 1}
                onToggle={() => toggleFile(file.id)}
              />
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12 }}>
        <button
          onClick={() => goToStage(1)}
          style={{ padding: "10px 20px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 14, cursor: "pointer" }}
        >
          ← Kembali
        </button>
        <button
          onClick={handleProceed}
          disabled={selectedCount === 0}
          style={{
            padding: "10px 24px",
            background: selectedCount > 0 ? "var(--accent-blue)" : "var(--border-color)",
            color: "white",
            border: "none",
            borderRadius: 4,
            fontSize: 14,
            fontWeight: 500,
            cursor: selectedCount > 0 ? "pointer" : "not-allowed",
          }}
        >
          Lanjut ke Analisis ({selectedCount} dokumen) →
        </button>
      </div>
    </div>
  );
}

function FileRow({ file, isLast, onToggle }: { file: FileEntry; isLast: boolean; onToggle: () => void }) {
  const iconMap: Record<string, string> = { docx: "📄", doc: "📄", pdf: "📋", txt: "📝" };
  const icon = iconMap[file.type.toLowerCase()] || "📎";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        borderBottom: isLast ? "none" : "1px solid var(--border-color)",
        cursor: "pointer",
        background: file.selected ? "rgba(91, 155, 213, 0.04)" : "transparent",
      }}
      onClick={onToggle}
    >
      <input
        type="checkbox"
        checked={file.selected}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
      />
      <span style={{ fontSize: 15 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {file.name}
        </div>
        {file.size && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{file.size}</div>
        )}
      </div>
      <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {file.type}
      </span>
    </div>
  );
}
