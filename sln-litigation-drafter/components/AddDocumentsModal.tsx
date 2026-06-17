"use client";

import { useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { FileEntry, DocMapEntry, DocCategory } from "@/types";

type Step = "discover" | "categorize" | "extract" | "decide";

const CATEGORY_CYCLE: DocCategory[] = ["KRITIS", "PENDUKUNG", "REFERENSI"];

interface ExtractLogEntry {
  name: string;
  category: DocCategory;
  status: "antri" | "memproses" | "selesai" | "cache" | "gagal" | "perlu_ocr";
  charCount?: number;
  method?: string;
  reason?: string;
}

interface AddedSummary {
  count: number;
  addedChars: number;
  oldChars: number;
  ocrCount: number;
  newTotal: number;
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export default function AddDocumentsModal({
  open,
  onClose,
  onReanalyze,
  onContinueWithout,
}: {
  open: boolean;
  onClose: () => void;
  onReanalyze: () => void;
  onContinueWithout: () => void;
}) {
  const { state, dispatch } = useWorkflow();

  const [step, setStep] = useState<Step>("discover");
  const [folderLink, setFolderLink] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [error, setError] = useState("");

  const [foundFiles, setFoundFiles] = useState<FileEntry[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [localMap, setLocalMap] = useState<DocMapEntry[]>([]);

  const [extractLog, setExtractLog] = useState<ExtractLogEntry[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [summary, setSummary] = useState<AddedSummary | null>(null);

  if (!open) return null;

  function reset() {
    setStep("discover");
    setFolderLink("");
    setError("");
    setFoundFiles([]);
    setCheckedIds(new Set());
    setLocalMap([]);
    setExtractLog([]);
    setSummary(null);
  }

  function closeAndReset() {
    reset();
    onClose();
  }

  async function discover() {
    if (!folderLink.trim()) return;
    setDiscovering(true);
    setError("");
    try {
      const res = await fetch("/api/sharepoint/list-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: folderLink.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal memuat daftar file");
      const files = (data.files ?? []) as FileEntry[];
      setFoundFiles(files);
      setCheckedIds(new Set(files.map((f) => f.id)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setDiscovering(false);
    }
  }

  function toggleCheck(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function confirmFiles() {
    const selected = foundFiles.filter((f) => checkedIds.has(f.id));
    if (selected.length === 0) return;
    setMapping(true);
    setError("");
    try {
      const res = await fetch("/api/sharepoint/map-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: selected, docTypeId: state.docTypeId, claimType: state.claimType }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal mengkategorikan file");
      setLocalMap((data.map ?? []) as DocMapEntry[]);
      setStep("categorize");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setMapping(false);
    }
  }

  function cycleCategory(fileId: string) {
    setLocalMap((m) =>
      m.map((e) => {
        if (e.fileId !== fileId) return e;
        const idx = CATEGORY_CYCLE.indexOf(e.category);
        return { ...e, category: CATEGORY_CYCLE[(idx + 1) % CATEGORY_CYCLE.length] };
      })
    );
  }

  async function runExtraction() {
    const selected = foundFiles.filter((f) => checkedIds.has(f.id));
    const mapById = new Map(localMap.map((e) => [e.fileId, e]));
    setStep("extract");
    setExtracting(true);
    setError("");
    setExtractLog(
      selected.map((f) => ({
        name: f.name,
        category: mapById.get(f.id)?.category ?? "REFERENSI",
        status: "antri" as const,
      }))
    );

    try {
      const res = await fetch("/api/sharepoint/add-documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: selected,
          docMap: localMap,
          sessionId: state.sessionId,
          folderPath: state.folderPath,
          docTypeId: state.docTypeId,
          practiceAreaId: state.practiceAreaId,
          claimType: state.claimType,
          ref: state.ref,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Gagal mengekstrak dokumen");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const updateRow = (name: string, patch: Partial<ExtractLogEntry>) =>
        setExtractLog((log) => log.map((r) => (r.name === name ? { ...r, ...patch } : r)));

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const ev of events) {
          const line = ev.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line.slice(6)); } catch { continue; }

          if (msg.type === "start") {
            updateRow(msg.name as string, { status: "memproses" });
          } else if (msg.type === "done") {
            updateRow(msg.name as string, {
              status: msg.fromCache ? "cache" : "selesai",
              charCount: msg.charCount as number,
              method: msg.method as string,
            });
          } else if (msg.type === "ocr_required") {
            updateRow(msg.name as string, { status: "perlu_ocr" });
          } else if (msg.type === "error") {
            updateRow(msg.name as string, { status: "gagal", reason: msg.reason as string });
          } else if (msg.type === "complete") {
            const added = (msg.addedFiles ?? []) as { id: string; name: string; category: DocCategory }[];
            // Merge added files into global inventory state.
            const addedEntries: FileEntry[] = selected.filter((f) => added.some((a) => a.id === f.id));
            const addedMap: DocMapEntry[] = localMap.filter((e) => added.some((a) => a.id === e.fileId));
            dispatch({ type: "SET_ALL_FILES", files: [...state.allFiles, ...addedEntries] });
            dispatch({ type: "SET_DOC_MAP", map: [...state.docMap, ...addedMap] });
            dispatch({ type: "MARK_FILES_ADDED", ids: added.map((a) => a.id) });
            const ocrCount = extractLog.filter((r) => r.status === "perlu_ocr").length;
            setSummary({
              count: added.length,
              addedChars: msg.addedChars as number,
              oldChars: msg.oldChars as number,
              newTotal: msg.newTotal as number,
              ocrCount,
            });
            // Persist updated inventory PDF + merged file list (fire-and-forget).
            if (state.folderPath) {
              fetch("/api/docx/inventory-save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: state.sessionId, folderPath: state.folderPath }),
              }).catch(() => {});
              fetch("/api/sharepoint/save-matter-file", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  folderPath: state.folderPath,
                  filename: `AI/file_list_${ts()}.json`,
                  content: JSON.stringify({
                    ref: state.ref,
                    files: [...state.allFiles, ...addedEntries],
                    timestamp: new Date().toISOString(),
                  }),
                }),
              }).catch(() => {});
            }
          } else if (msg.error) {
            setError(msg.error as string);
          }
        }
      }
      setStep("decide");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setExtracting(false);
    }
  }

  const checkedCount = checkedIds.size;
  const catLabel = (c: DocCategory) =>
    c === "KRITIS" ? "#c0392b" : c === "PENDUKUNG" ? "#b8860b" : "#5a6b7b";

  const overlay: React.CSSProperties = {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000,
    display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto",
  };
  const panel: React.CSSProperties = {
    background: "var(--bg-base, #fff)", borderRadius: 10, maxWidth: 720, width: "100%",
    padding: 28, boxShadow: "0 20px 60px rgba(0,0,0,0.3)", fontFamily: "system-ui, sans-serif",
  };
  const btnPrimary: React.CSSProperties = {
    background: "var(--accent-blue, #2563eb)", color: "#fff", border: "none", borderRadius: 6,
    padding: "9px 18px", cursor: "pointer", fontSize: 14,
  };
  const btnSecondary: React.CSSProperties = {
    background: "transparent", color: "var(--text-primary, #333)", border: "1px solid var(--border-color, #ccc)",
    borderRadius: 6, padding: "9px 18px", cursor: "pointer", fontSize: 14,
  };

  return (
    <div style={overlay} onClick={closeAndReset}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Tambah Dokumen</h3>
          <button onClick={closeAndReset} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", lineHeight: 1, color: "var(--text-muted,#888)" }}>×</button>
        </div>

        {error && (
          <div style={{ padding: 12, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error,#dc2626)", borderRadius: 4, color: "var(--error,#dc2626)", fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {/* Step 1 — discover */}
        {step === "discover" && (
          <div>
            <p style={{ fontSize: 13, color: "var(--text-muted,#666)", marginBottom: 12 }}>
              Tempel tautan folder SharePoint berisi dokumen tambahan untuk perkara ini.
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                type="text"
                value={folderLink}
                onChange={(e) => setFolderLink(e.target.value)}
                placeholder="https://...sharepoint.com/..."
                style={{ flex: 1, padding: "9px 12px", border: "1px solid var(--border-color,#ccc)", borderRadius: 6, fontSize: 13 }}
              />
              <button onClick={() => void discover()} disabled={discovering || !folderLink.trim()} style={{ ...btnSecondary, opacity: discovering || !folderLink.trim() ? 0.5 : 1 }}>
                {discovering ? "Memuat..." : "Muat Daftar"}
              </button>
            </div>

            {foundFiles.length > 0 && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: "var(--text-muted,#666)" }}>{checkedCount} dari {foundFiles.length} file dipilih</span>
                  <div style={{ display: "flex", gap: 12 }}>
                    <button onClick={() => setCheckedIds(new Set(foundFiles.map((f) => f.id)))} style={{ background: "none", border: "none", color: "var(--accent-blue,#2563eb)", cursor: "pointer", fontSize: 12 }}>Pilih Semua</button>
                    <button onClick={() => setCheckedIds(new Set())} style={{ background: "none", border: "none", color: "var(--accent-blue,#2563eb)", cursor: "pointer", fontSize: 12 }}>Batalkan Semua</button>
                  </div>
                </div>
                <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid var(--border-color,#e5e7eb)", borderRadius: 6, marginBottom: 16 }}>
                  {foundFiles.map((f) => (
                    <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--border-color,#f0f0f0)", cursor: "pointer", fontSize: 13 }}>
                      <input type="checkbox" checked={checkedIds.has(f.id)} onChange={() => toggleCheck(f.id)} />
                      <span style={{ flex: 1 }}>{f.name}</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted,#999)" }}>{f.size}</span>
                    </label>
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => void confirmFiles()} disabled={checkedCount === 0 || mapping} style={{ ...btnPrimary, opacity: checkedCount === 0 || mapping ? 0.5 : 1 }}>
                    {mapping ? "Mengkategorikan..." : `Tambahkan File Ini (${checkedCount})`}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 2 — categorize */}
        {step === "categorize" && (
          <div>
            <p style={{ fontSize: 13, color: "var(--text-muted,#666)", marginBottom: 12 }}>
              Tinjau kategorisasi AI. Klik kategori untuk mengubah (KRITIS → PENDUKUNG → REFERENSI).
            </p>
            <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border-color,#e5e7eb)", borderRadius: 6, marginBottom: 16 }}>
              {localMap.map((e) => {
                const file = foundFiles.find((f) => f.id === e.fileId);
                return (
                  <div key={e.fileId} style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-color,#f0f0f0)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ flex: 1, fontSize: 13 }}>{file?.name ?? e.fileId}</span>
                      <button
                        onClick={() => cycleCategory(e.fileId)}
                        style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: catLabel(e.category), border: "none", borderRadius: 4, padding: "3px 10px", cursor: "pointer" }}
                      >
                        {e.category}
                      </button>
                    </div>
                    {e.reasoning && <p style={{ fontSize: 11, color: "var(--text-muted,#888)", margin: "6px 0 0" }}>{e.reasoning}</p>}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <button onClick={() => setStep("discover")} style={btnSecondary}>← Kembali</button>
              <button onClick={() => void runExtraction()} style={btnPrimary}>Konfirmasi &amp; Ekstrak ({localMap.length} file) →</button>
            </div>
          </div>
        )}

        {/* Step 3 — extract */}
        {step === "extract" && (
          <div>
            <p style={{ fontSize: 13, color: "var(--text-muted,#666)", marginBottom: 12 }}>
              {extracting ? "Mengekstrak dokumen baru..." : "Ekstraksi selesai."}
            </p>
            <div style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--border-color,#e5e7eb)", borderRadius: 6 }}>
              {extractLog.map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--border-color,#f0f0f0)", fontSize: 13 }}>
                  <span style={{ width: 18 }}>
                    {r.status === "selesai" ? "✓" : r.status === "cache" ? "⚡" : r.status === "gagal" ? "✗" : r.status === "perlu_ocr" ? "⚠" : r.status === "memproses" ? "…" : "·"}
                  </span>
                  <span style={{ flex: 1 }}>{r.name}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: catLabel(r.category) }}>{r.category}</span>
                  {r.charCount != null && <span style={{ fontSize: 11, color: "var(--text-muted,#999)" }}>{(r.charCount / 1000).toFixed(1)}k</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Step 4 + 5 — decide */}
        {step === "decide" && summary && (
          <div>
            <div style={{ padding: 14, background: "rgba(22,163,74,0.08)", border: "1px solid #16a34a", borderRadius: 6, marginBottom: 16 }}>
              <p style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px", color: "#16a34a" }}>
                {summary.ocrCount > 0 && summary.ocrCount === summary.count
                  ? `${summary.count} dokumen ditambahkan ke inventaris (perlu OCR — belum ada konten teks).`
                  : summary.ocrCount > 0
                  ? `${summary.count - summary.ocrCount} dari ${summary.count} dokumen berhasil diekstrak (${summary.addedChars.toLocaleString("id-ID")} karakter); ${summary.ocrCount} perlu OCR.`
                  : `${summary.count} dokumen baru berhasil ditambahkan (${summary.addedChars.toLocaleString("id-ID")} karakter).`}
              </p>
              <p style={{ fontSize: 13, color: "var(--text-muted,#555)", margin: 0 }}>
                Analisis perkara perlu dijalankan ulang dengan dokumen lengkap.
              </p>
            </div>

            <div style={{ marginBottom: 18 }}>
              {extractLog.filter((r) => r.status === "selesai" || r.status === "cache").map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", fontSize: 13 }}>
                  <span style={{ flex: 1 }}>{r.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#fff", background: "#16a34a", borderRadius: 4, padding: "2px 8px" }}>Ditambahkan</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: catLabel(r.category) }}>{r.category}</span>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
              <button onClick={() => { closeAndReset(); onContinueWithout(); }} style={btnSecondary}>
                Lanjutkan Tanpa Analisis Ulang
              </button>
              <button onClick={() => { closeAndReset(); onReanalyze(); }} style={btnPrimary}>
                Jalankan Ulang Analisis
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
