"use client";

import { useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { FileEntry, DocMapEntry, DocCategory, DocDocumentType } from "@/types";

// ─── Constants ────────────────────────────────────────────────────────────────

type Substep = "2A" | "2B" | "2C" | "2D";

const CATEGORY_META: Record<DocCategory, { label: string; color: string; bg: string; defaultSelected: boolean }> = {
  KRITIS:        { label: "KRITIS",         color: "#e74c3c", bg: "rgba(231,76,60,0.08)",  defaultSelected: true  },
  PENDUKUNG:     { label: "PENDUKUNG",      color: "#e67e22", bg: "rgba(230,126,34,0.08)", defaultSelected: true  },
  REFERENSI:     { label: "REFERENSI",      color: "#8aa3bc", bg: "rgba(138,163,188,0.08)",defaultSelected: true  },
  TIDAK_RELEVAN: { label: "TIDAK RELEVAN",  color: "#555",    bg: "transparent",           defaultSelected: false },
};

const DOC_TYPE_LABELS: Record<DocDocumentType, string> = {
  perjanjian_kontrak: "Perjanjian/Kontrak",
  putusan_penetapan:  "Putusan/Penetapan",
  surat_menyurat:     "Surat Menyurat",
  bukti_transaksi:    "Bukti Transaksi",
  dokumen_korporasi:  "Dokumen Korporasi",
  tidak_dikenali:     "Tidak Dikenali",
};

const CATEGORY_ORDER: DocCategory[] = ["KRITIS", "PENDUKUNG", "REFERENSI", "TIDAK_RELEVAN"];

const FILE_ICON: Record<string, string> = { docx: "📄", doc: "📄", pdf: "📋", txt: "📝" };

// ─── Component ────────────────────────────────────────────────────────────────

export default function Stage2Files() {
  const { state, dispatch, goToStage } = useWorkflow();

  // Restore substep from state: if docMap exists → 2C, if allFiles → 2A with files shown
  const initialSubstep: Substep =
    state.docMap.length > 0 ? "2C" : "2A";

  const [substep, setSubstep] = useState<Substep>(initialSubstep);
  const [folderLink, setFolderLink] = useState(state.folderPath || "");
  const [discovering, setDiscovering] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [error, setError] = useState("");

  // Local copy of docMap so the drafter can edit categories without dispatching every keystroke
  const [localMap, setLocalMap] = useState<DocMapEntry[]>(state.docMap);

  // 2D progress
  const [extractPhase, setExtractPhase] = useState<"idle" | "extracting" | "done">("idle");
  const [extractProgress, setExtractProgress] = useState({ current: 0, total: 0, name: "", skipped: [] as { name: string; reason: string }[] });

  // ── 2A: Load filenames only ─────────────────────────────────────────────────
  async function discoverFiles() {
    const link = folderLink.trim();
    if (!link) return;
    setDiscovering(true);
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
      setLocalMap([]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setDiscovering(false);
    }
  }

  // ── 2B: AI document map ──────────────────────────────────────────────────────
  async function buildDocMap() {
    setMapping(true);
    setError("");
    setSubstep("2B");
    try {
      const res = await fetch("/api/sharepoint/map-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: state.allFiles,
          docTypeId: state.docTypeId,
          claimType: state.claimType,
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Gagal membuat peta dokumen");
      dispatch({ type: "SET_DOC_MAP", map: result.map });
      setLocalMap(result.map);
      // Apply default selection based on category
      const updatedFiles = state.allFiles.map((f) => {
        const entry = (result.map as DocMapEntry[]).find((e) => e.fileId === f.id);
        const cat = entry?.category ?? "PENDUKUNG";
        return { ...f, selected: CATEGORY_META[cat as DocCategory].defaultSelected };
      });
      dispatch({ type: "SET_ALL_FILES", files: updatedFiles });
      setSubstep("2C");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
      setSubstep("2A");
    } finally {
      setMapping(false);
    }
  }

  // ── 2C: Drafter edits selection ──────────────────────────────────────────────
  function toggleFile(id: string) {
    dispatch({ type: "TOGGLE_FILE", id });
  }

  function updateCategory(fileId: string, category: DocCategory) {
    const patch = { category };
    setLocalMap((m) => m.map((e) => e.fileId === fileId ? { ...e, ...patch } : e));
    dispatch({ type: "UPDATE_DOC_MAP_ENTRY", fileId, patch });
    // Auto-update selection when category changes
    const defaultSel = CATEGORY_META[category].defaultSelected;
    dispatch({
      type: "SET_ALL_FILES",
      files: state.allFiles.map((f) => f.id === fileId ? { ...f, selected: defaultSel } : f),
    });
  }

  function confirmSelection() {
    const selected = state.allFiles.filter((f) => f.selected);
    if (selected.length === 0) {
      setError("Pilih minimal satu dokumen untuk dilanjutkan.");
      return;
    }
    // Sort selected: KRITIS first, then PENDUKUNG, then rest
    const catOrder = (id: string) => {
      const entry = localMap.find((e) => e.fileId === id);
      return CATEGORY_ORDER.indexOf(entry?.category ?? "REFERENSI");
    };
    const sorted = [...selected].sort((a, b) => catOrder(a.id) - catOrder(b.id));
    dispatch({ type: "SET_SELECTED_FILES", files: sorted });
    setSubstep("2D");
  }

  // ── 2D: Targeted extraction ───────────────────────────────────────────────────
  async function runExtraction() {
    const selected = state.selectedFiles;
    if (!selected.length) return;
    setExtractPhase("extracting");
    setExtractProgress({ current: 0, total: selected.length, name: "", skipped: [] });
    setError("");

    try {
      const res = await fetch("/api/sharepoint/read-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: selected, sessionId: state.sessionId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Gagal mengekstrak dokumen");
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;
          try {
            const ev = JSON.parse(jsonStr) as Record<string, unknown>;
            if (typeof ev.progress === "number") {
              setExtractProgress((p) => ({ ...p, current: ev.progress as number, total: ev.total as number, name: (ev.name as string) ?? "" }));
            } else if (ev.skipped) {
              setExtractProgress((p) => ({ ...p, skipped: [...p.skipped, { name: ev.skipped as string, reason: (ev.reason as string) ?? "" }] }));
            } else if (ev.error) {
              throw new Error(ev.error as string);
            } else if (ev.done) {
              break outer;
            }
          } catch (inner) {
            if (inner instanceof Error && inner.message !== "Unexpected token") throw inner;
          }
        }
      }

      setExtractPhase("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan saat ekstraksi");
      setExtractPhase("idle");
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const fileById = (id: string) => state.allFiles.find((f) => f.id === id);
  const mapById  = (id: string) => localMap.find((e) => e.fileId === id);

  const selectedCount = state.allFiles.filter((f) => f.selected).length;
  const pct = extractProgress.total > 0 ? Math.round((extractProgress.current / extractProgress.total) * 100) : 0;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
          Dokumen Perkara
        </h1>
        <SubstepBadge current={substep} />
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* ── 2A: File Discovery ─────────────────────────────────────────────── */}
      {(substep === "2A" || substep === "2B") && (
        <div>
          <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 20 }}>
            Masukkan sharing link folder SharePoint yang berisi dokumen perkara.
          </p>
          <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
            <input
              type="text"
              value={folderLink}
              onChange={(e) => { setFolderLink(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && discoverFiles()}
              placeholder="https://sandiva.sharepoint.com/:f:/s/SiteName/AbCdEfGhIj..."
              style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }}
              disabled={discovering || mapping}
            />
            <button
              onClick={discoverFiles}
              disabled={discovering || mapping || !folderLink.trim()}
              style={{ padding: "8px 20px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", opacity: discovering || !folderLink.trim() ? 0.6 : 1 }}
            >
              {discovering ? "Memuat..." : "Muat Daftar"}
            </button>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 20 }}>
            Buka folder di SharePoint → klik <strong>Bagikan</strong> → salin link → tempel di sini.
          </p>

          {state.allFiles.length > 0 && !mapping && (
            <>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 10 }}>
                {state.allFiles.length} file ditemukan
              </div>
              <div style={{ border: "1px solid var(--border-color)", borderRadius: 4, maxHeight: 240, overflowY: "auto", marginBottom: 20 }}>
                {state.allFiles.map((f, i) => (
                  <div key={f.id} style={{ display: "flex", gap: 10, padding: "8px 12px", borderBottom: i < state.allFiles.length - 1 ? "1px solid var(--border-color)" : "none", alignItems: "center" }}>
                    <span style={{ fontSize: 14 }}>{FILE_ICON[f.type] || "📎"}</span>
                    <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{f.size}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" }}>{f.type}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={buildDocMap}
                disabled={mapping}
                style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: mapping ? "wait" : "pointer" }}
              >
                {mapping ? "AI sedang menganalisis..." : `Analisis dengan AI →`}
              </button>
            </>
          )}

          {mapping && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 16, background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 4, marginTop: 16 }}>
              <Spinner />
              <span style={{ fontSize: 14, color: "var(--text-muted)" }}>
                AI sedang mengategorikan {state.allFiles.length} file...
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── 2C: Review map ─────────────────────────────────────────────────── */}
      {substep === "2C" && (
        <div>
          <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 6 }}>
            AI telah mengkategorikan {state.allFiles.length} file. Tinjau, ubah kategori jika diperlukan, lalu konfirmasi.
          </p>
          <div style={{ display: "flex", gap: 16, marginBottom: 20, fontSize: 12, color: "var(--text-muted)" }}>
            {CATEGORY_ORDER.map((cat) => {
              const count = localMap.filter((e) => e.category === cat).length;
              const meta = CATEGORY_META[cat];
              return (
                <span key={cat} style={{ color: meta.color, fontWeight: 600 }}>
                  {meta.label} {count}
                </span>
              );
            })}
            <span style={{ marginLeft: "auto" }}>{selectedCount} dipilih</span>
          </div>

          {CATEGORY_ORDER.map((cat) => {
            const entries = localMap.filter((e) => e.category === cat);
            if (entries.length === 0) return null;
            const meta = CATEGORY_META[cat];
            return (
              <div key={cat} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, letterSpacing: "0.1em", fontWeight: 700, color: meta.color, marginBottom: 8 }}>
                  {meta.label} — {entries.length} file
                </div>
                <div style={{ border: `1px solid ${meta.color}33`, borderRadius: 4, overflow: "hidden" }}>
                  {entries.map((entry, i) => {
                    const file = fileById(entry.fileId);
                    if (!file) return null;
                    return (
                      <MapRow
                        key={entry.fileId}
                        file={file}
                        entry={entry}
                        isLast={i === entries.length - 1}
                        onToggle={() => toggleFile(file.id)}
                        onCategoryChange={(c) => updateCategory(file.id, c)}
                        meta={meta}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <button
              onClick={() => setSubstep("2A")}
              style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}
            >
              ← Ganti Folder
            </button>
            <button
              onClick={confirmSelection}
              disabled={selectedCount === 0}
              style={{ padding: "10px 24px", background: selectedCount > 0 ? "var(--accent-blue)" : "var(--border-color)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: selectedCount > 0 ? "pointer" : "not-allowed" }}
            >
              Konfirmasi &amp; Ekstrak ({selectedCount} file) →
            </button>
          </div>
        </div>
      )}

      {/* ── 2D: Targeted extraction ─────────────────────────────────────────── */}
      {substep === "2D" && (
        <div>
          <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 20 }}>
            Mengekstrak konten dari {state.selectedFiles.length} file yang dipilih. File KRITIS diproses terlebih dahulu.
          </p>

          {/* Selected file list with extraction priority order */}
          <div style={{ border: "1px solid var(--border-color)", borderRadius: 4, maxHeight: 220, overflowY: "auto", marginBottom: 20 }}>
            {state.selectedFiles.map((f, i) => {
              const entry = mapById(f.id);
              const cat = entry?.category ?? "PENDUKUNG";
              const meta = CATEGORY_META[cat];
              const isDone = i < extractProgress.current;
              return (
                <div key={f.id} style={{ display: "flex", gap: 10, padding: "8px 12px", borderBottom: i < state.selectedFiles.length - 1 ? "1px solid var(--border-color)" : "none", alignItems: "center", opacity: isDone ? 0.5 : 1 }}>
                  <span style={{ fontSize: 13 }}>{isDone ? "✓" : FILE_ICON[f.type] || "📎"}</span>
                  <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, letterSpacing: "0.05em" }}>{meta.label}</span>
                </div>
              );
            })}
          </div>

          {extractPhase === "idle" && (
            <button
              onClick={runExtraction}
              style={{ padding: "10px 24px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer", marginBottom: 16 }}
            >
              Mulai Ekstraksi
            </button>
          )}

          {extractPhase === "extracting" && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
                <span>
                  Memproses file {extractProgress.current} dari {extractProgress.total}
                  {extractProgress.name ? ` — ${extractProgress.name}` : ""}
                </span>
                <span>{pct}%</span>
              </div>
              <div style={{ height: 6, background: "var(--border-color)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: "var(--accent-blue)", borderRadius: 3, transition: "width 0.3s ease" }} />
              </div>
              {extractProgress.skipped.map((s, i) => (
                <div key={i} style={{ fontSize: 12, color: "#e67e22", marginTop: 6 }}>⚠ {s.name} — {s.reason}</div>
              ))}
            </div>
          )}

          {extractPhase === "done" && (
            <>
              {extractProgress.skipped.length > 0 && (
                <div style={{ padding: "10px 14px", background: "rgba(230,126,34,0.08)", border: "1px solid rgba(230,126,34,0.3)", borderRadius: 4, fontSize: 12, marginBottom: 16 }}>
                  <strong style={{ color: "#e67e22" }}>{extractProgress.skipped.length} file dilewati:</strong>
                  {extractProgress.skipped.map((s, i) => (
                    <div key={i} style={{ color: "var(--text-muted)", marginTop: 2 }}>• {s.name} — {s.reason}</div>
                  ))}
                </div>
              )}
              <div style={{ padding: "10px 14px", background: "rgba(39,174,96,0.08)", border: "1px solid var(--success)", borderRadius: 4, fontSize: 13, color: "var(--success)", marginBottom: 20 }}>
                ✓ Ekstraksi selesai — {extractProgress.current - extractProgress.skipped.length} file berhasil diproses
              </div>
            </>
          )}

          {error && (
            <div style={{ fontSize: 13, color: "var(--error)", marginBottom: 16 }}>
              {error}
              <button onClick={runExtraction} style={{ marginLeft: 10, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>Coba lagi</button>
            </div>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => setSubstep("2C")}
              disabled={extractPhase === "extracting"}
              style={{ padding: "10px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}
            >
              ← Ubah Pilihan
            </button>
            <button
              onClick={() => goToStage(3)}
              disabled={extractPhase !== "done"}
              style={{ padding: "10px 24px", background: extractPhase === "done" ? "var(--accent-blue)" : "var(--border-color)", color: "white", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: extractPhase === "done" ? "pointer" : "not-allowed" }}
            >
              Lanjut ke Analisis →
            </button>
          </div>
        </div>
      )}

      {/* Back to Stage 1 — only visible in 2A */}
      {substep === "2A" && (
        <div style={{ marginTop: 24 }}>
          <button
            onClick={() => goToStage(1)}
            style={{ padding: "10px 20px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 14, cursor: "pointer" }}
          >
            ← Kembali ke Pilihan Dokumen
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SubstepBadge({ current }: { current: Substep }) {
  const steps: { id: Substep; label: string }[] = [
    { id: "2A", label: "Temukan" },
    { id: "2B", label: "AI Map" },
    { id: "2C", label: "Tinjau" },
    { id: "2D", label: "Ekstrak" },
  ];
  const order = ["2A", "2B", "2C", "2D"];
  const currentIdx = order.indexOf(current);
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const active = s.id === current;
        return (
          <span
            key={s.id}
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 10,
              fontWeight: active ? 600 : 400,
              background: done ? "var(--accent-blue)" : active ? "rgba(91,155,213,0.15)" : "transparent",
              color: done ? "white" : active ? "var(--accent-blue)" : "var(--text-muted)",
              border: active ? "1px solid var(--accent-blue)" : "1px solid transparent",
            }}
          >
            {done ? "✓" : s.id} {s.label}
          </span>
        );
      })}
    </div>
  );
}

function MapRow({
  file,
  entry,
  isLast,
  onToggle,
  onCategoryChange,
  meta,
}: {
  file: FileEntry;
  entry: DocMapEntry;
  isLast: boolean;
  onToggle: () => void;
  onCategoryChange: (c: DocCategory) => void;
  meta: { color: string; bg: string };
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--border-color)", background: file.selected ? meta.bg : "transparent" }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer" }}
        onClick={onToggle}
      >
        <input
          type="checkbox"
          checked={file.selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
        />
        <span style={{ fontSize: 14 }}>{FILE_ICON[file.type] || "📎"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {file.name}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {DOC_TYPE_LABELS[entry.documentType]} · {file.size || "—"}
          </div>
        </div>
        {/* Category dropdown */}
        <select
          value={entry.category}
          onChange={(e) => { e.stopPropagation(); onCategoryChange(e.target.value as DocCategory); }}
          onClick={(e) => e.stopPropagation()}
          style={{ fontSize: 11, fontWeight: 700, color: meta.color, background: "var(--bg-surface)", border: `1px solid ${meta.color}55`, borderRadius: 3, padding: "2px 4px", cursor: "pointer" }}
        >
          {(Object.keys(CATEGORY_META) as DocCategory[]).map((cat) => (
            <option key={cat} value={cat}>{CATEGORY_META[cat].label}</option>
          ))}
        </select>
        {/* Expand reasoning */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
          title="Lihat alasan AI"
        >
          {expanded ? "▲" : "▼"}
        </button>
      </div>
      {expanded && (
        <div style={{ padding: "0 14px 10px 46px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic", lineHeight: 1.5 }}>
          {entry.reasoning}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <>
      <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--border-color)", borderTopColor: "var(--accent-blue)", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
