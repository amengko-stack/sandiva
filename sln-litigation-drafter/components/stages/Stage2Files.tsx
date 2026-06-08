"use client";

import { useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { FileEntry } from "@/types";

function ext(name: string): string {
  return name.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
}

function filenameFromUrl(url: string): string {
  // Try to extract a filename from the URL path, fallback to "Dokumen"
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const last = parts[parts.length - 1];
    if (last && last.includes(".")) return last;
  } catch {
    // ignore
  }
  return "Dokumen";
}

function parseLinks(raw: string): FileEntry[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("http"))
    .map((url, i) => {
      const name = filenameFromUrl(url);
      const type = ext(name) || "docx";
      return {
        id: `link-${i}`,
        name,
        path: url,
        size: "",
        type,
        selected: true,
      };
    });
}

export default function Stage2Files() {
  const { state, dispatch, goToStage } = useWorkflow();
  const [linksText, setLinksText] = useState(
    state.allFiles.map((f) => f.path).join("\n") || ""
  );
  const [error, setError] = useState("");

  const parsedFiles = parseLinks(linksText);
  const files: FileEntry[] = state.allFiles.length > 0 && linksText === state.allFiles.map((f) => f.path).join("\n")
    ? state.allFiles
    : parsedFiles;

  const selectedCount = files.filter((f) => f.selected).length;

  function handleLinksChange(val: string) {
    setLinksText(val);
    setError("");
    const parsed = parseLinks(val);
    dispatch({ type: "SET_ALL_FILES", files: parsed });
  }

  function toggleFile(id: string) {
    dispatch({ type: "TOGGLE_FILE", id });
  }

  function toggleAll(selected: boolean) {
    dispatch({ type: "SET_ALL_FILES", files: files.map((f) => ({ ...f, selected })) });
  }

  function handleProceed() {
    if (files.length === 0) {
      setError("Masukkan minimal satu sharing link dokumen.");
      return;
    }
    const selected = files.filter((f) => f.selected);
    if (selected.length === 0) {
      setError("Pilih minimal satu dokumen untuk dilanjutkan.");
      return;
    }
    dispatch({ type: "SET_FOLDER", folderPath: linksText });
    dispatch({ type: "SET_SELECTED_FILES", files: selected });
    goToStage(3);
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
        Dokumen Perkara
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 32 }}>
        Masukkan sharing link SharePoint untuk setiap dokumen perkara — satu link per baris.
      </p>

      {/* Link textarea */}
      <div style={{ marginBottom: 24 }}>
        <label style={{ display: "block", fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
          Sharing Link SharePoint
        </label>
        <textarea
          value={linksText}
          onChange={(e) => handleLinksChange(e.target.value)}
          rows={6}
          placeholder={"https://sandiva.sharepoint.com/:w:/s/5018BVI/IQDJBMI...\nhttps://sandiva.sharepoint.com/:w:/s/5018BVI/AbCdEfGh...\nhttps://sandiva.sharepoint.com/:b:/s/5018BVI/XyZwVuTs..."}
          style={{
            width: "100%",
            resize: "vertical",
            fontFamily: "monospace",
            fontSize: 12,
          }}
        />
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
          Buka dokumen di SharePoint → klik <strong>Bagikan</strong> → salin link → tempel di sini.
        </p>
        {error && (
          <p style={{ color: "var(--error)", fontSize: 13, marginTop: 8 }}>{error}</p>
        )}
      </div>

      {/* File preview list */}
      {files.length > 0 && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {files.length} dokumen · {selectedCount} dipilih
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

      {/* Navigation */}
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
        <div style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {file.path}
        </div>
      </div>
    </div>
  );
}
