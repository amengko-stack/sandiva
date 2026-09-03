"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { ReviewTableRow, DocCategory } from "@/types";

type ReviewMessage =
  | { type: "start"; total: number }
  | { type: "row"; row: ReviewTableRow; index: number; total: number }
  | { type: "warning"; message: string }
  | { type: "done"; rows: ReviewTableRow[] }
  | { type: "error"; message: string };

type SortKey = "fileName" | "category" | "jenisDokumen" | "tanggal" | "nilai";

const CATEGORY_ORDER: Record<string, number> = { KRITIS: 0, PENDUKUNG: 1, REFERENSI: 2, "—": 3 };

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function csvEscape(v: string): string {
  return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export default function ReviewTablePanel() {
  const { state, dispatch } = useWorkflow();
  const rows = state.reviewTable;

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState<DocCategory | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const checkedStored = useRef(false);

  // Stop an in-flight generation when the drafter navigates away.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // If this tab has no table yet, check the session blob (another tab or an
  // interrupted run may have persisted one).
  useEffect(() => {
    if (checkedStored.current || rows.length > 0 || !state.sessionId) return;
    checkedStored.current = true;
    fetch(`/api/analyze/review-table?sessionId=${encodeURIComponent(state.sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { rows?: ReviewTableRow[] } | null) => {
        if (data?.rows?.length) dispatch({ type: "SET_REVIEW_TABLE", rows: data.rows });
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setError("");
    setWarning("");
    setProgress(null);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const collected: ReviewTableRow[] = [];
    let sawDone = false;
    try {
      const res = await fetch("/api/analyze/review-table", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortRef.current.signal,
        body: JSON.stringify({
          sessionId: state.sessionId,
          docTypeId: state.docTypeId,
          claimType: state.claimType,
          pihak: state.pihak,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `Gagal membuat tabel (HTTP ${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: ReviewMessage;
          try {
            msg = JSON.parse(line) as ReviewMessage;
          } catch {
            continue;
          }
          if (msg.type === "start") {
            setProgress({ done: 0, total: msg.total });
          } else if (msg.type === "row") {
            collected.push(msg.row);
            setProgress({ done: collected.length, total: msg.total });
            // Show rows as they land (ordered by original index for stability).
            dispatch({
              type: "SET_REVIEW_TABLE",
              rows: [...collected].sort((a, b) => a.fileName.localeCompare(b.fileName, "id")),
            });
          } else if (msg.type === "warning") {
            setWarning(msg.message);
          } else if (msg.type === "done") {
            sawDone = true;
            dispatch({ type: "SET_REVIEW_TABLE", rows: msg.rows });
            // Audit copy to the matter's AI folder (fire-and-forget).
            if (state.folderPath) {
              fetch("/api/sharepoint/save-matter-file", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  sessionId: state.sessionId,
                  folderPath: state.folderPath,
                  filename: `AI/review_table_${ts()}.json`,
                  content: JSON.stringify({ ref: state.ref, rows: msg.rows, timestamp: new Date().toISOString() }),
                }),
              }).catch(() => {});
            }
          } else if (msg.type === "error") {
            throw new Error(msg.message);
          }
        }
      }
      if (!sawDone && collected.length === 0) {
        throw new Error("Koneksi terputus sebelum tabel selesai — coba lagi.");
      }
      if (!sawDone) {
        setWarning("Koneksi terputus sebelum semua dokumen diproses — tabel parsial ditampilkan; klik Buat Ulang untuk melengkapi.");
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Terjadi kesalahan saat membuat tabel");
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }

  function downloadCsv() {
    const header = ["Dokumen", "Kategori", "Jenis", "Tanggal", "Para Pihak", "Nilai", "Poin Kunci", "Relevansi", "Status"];
    const lines = [header.join(";")].concat(
      displayRows.map((r) =>
        [r.fileName, r.category, r.jenisDokumen, r.tanggal, r.paraPihak, r.nilai, r.poinKunci, r.relevansi, r.status]
          .map(csvEscape)
          .join(";")
      )
    );
    // BOM + semicolon delimiter: opens correctly in Excel with Indonesian locale.
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(state.ref || "tabel-tinjauan").replace(/[\\/"]/g, "-")}_tinjauan_dokumen.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  let displayRows = categoryFilter ? rows.filter((r) => r.category === categoryFilter) : rows;
  if (sortKey) {
    displayRows = [...displayRows].sort((a, b) => {
      const cmp =
        sortKey === "category"
          ? (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9)
          : a[sortKey].localeCompare(b[sortKey], "id");
      return sortAsc ? cmp : -cmp;
    });
  }

  const failedCount = rows.filter((r) => r.status === "gagal").length;

  const th = (label: string, key?: SortKey): React.ReactNode => (
    <th
      onClick={key ? () => toggleSort(key) : undefined}
      style={{
        padding: "8px 10px",
        textAlign: "left",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
        borderBottom: "1px solid var(--border-color)",
        whiteSpace: "nowrap",
        cursor: key ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      {label}
      {key && sortKey === key ? (sortAsc ? " ↑" : " ↓") : ""}
    </th>
  );

  const catColor = (c: string) =>
    c === "KRITIS" ? "#c0392b" : c === "PENDUKUNG" ? "#b8860b" : "var(--text-muted)";

  return (
    <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 4, marginBottom: 24 }}>
      {/* Panel header */}
      <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: collapsed ? "none" : "1px solid var(--border-color)" }}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          style={{ background: "none", border: "none", color: "var(--text-primary)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}
        >
          {collapsed ? "▸" : "▾"} Tabel Tinjauan Dokumen
        </button>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {rows.length > 0
            ? `${rows.length} dokumen${failedCount > 0 ? ` — ${failedCount} gagal` : ""}`
            : "ringkasan terstruktur per dokumen"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {rows.length > 0 && (
            <button onClick={downloadCsv} style={btnSmall}>
              ⬇ CSV
            </button>
          )}
          <button onClick={generate} disabled={generating} style={{ ...btnSmall, opacity: generating ? 0.5 : 1 }}>
            {generating
              ? `Memproses${progress ? ` ${progress.done}/${progress.total}` : ""}...`
              : rows.length > 0
              ? "↻ Buat Ulang"
              : "Buat Tabel Tinjauan"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div style={{ padding: rows.length > 0 || error || warning ? "12px 16px 16px" : "16px" }}>
          {error && (
            <div style={{ padding: 12, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 12 }}>
              {error}
              <button onClick={generate} style={{ marginLeft: 10, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>
                Coba lagi
              </button>
            </div>
          )}
          {warning && (
            <div style={{ padding: 10, background: "rgba(184,134,11,0.1)", border: "1px solid var(--accent-gold)", borderRadius: 4, color: "var(--accent-gold)", fontSize: 12, marginBottom: 12 }}>
              {warning}
            </div>
          )}

          {rows.length === 0 && !generating && !error && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              Buat tabel ringkasan terstruktur dari semua dokumen yang diekstrak — jenis, tanggal, para pihak,
              nilai, dan relevansi per dokumen — untuk ditinjau sekilas atau diunduh sebagai CSV.
            </p>
          )}

          {generating && rows.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              Menganalisis dokumen{progress ? ` (${progress.done}/${progress.total})` : ""}...
            </p>
          )}

          {rows.length > 0 && (
            <>
              {/* Category filter chips */}
              <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                {([null, "KRITIS", "PENDUKUNG", "REFERENSI"] as (DocCategory | null)[]).map((c) => (
                  <button
                    key={c ?? "all"}
                    onClick={() => setCategoryFilter(c)}
                    style={{
                      padding: "3px 10px",
                      fontSize: 11,
                      borderRadius: 12,
                      border: `1px solid ${categoryFilter === c ? "var(--accent-blue)" : "var(--border-color)"}`,
                      background: categoryFilter === c ? "var(--accent-blue)" : "transparent",
                      color: categoryFilter === c ? "white" : "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    {c ?? "Semua"}
                  </button>
                ))}
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
                  <thead>
                    <tr>
                      {th("Dokumen", "fileName")}
                      {th("Kategori", "category")}
                      {th("Jenis", "jenisDokumen")}
                      {th("Tanggal", "tanggal")}
                      {th("Para Pihak")}
                      {th("Nilai", "nilai")}
                      {th("Poin Kunci")}
                      {th("Relevansi")}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((r, i) => (
                      <tr key={`${r.fileName}-${i}`} title={r.status === "gagal" ? `Gagal: ${r.reason ?? "?"}` : undefined}>
                        <td style={{ ...td, fontWeight: 500, color: "var(--text-primary)", maxWidth: 180, wordBreak: "break-word" }}>
                          {r.status === "gagal" ? "⚠ " : ""}
                          {r.fileName}
                        </td>
                        <td style={{ ...td, color: catColor(r.category), whiteSpace: "nowrap", fontWeight: 500 }}>{r.category}</td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>{r.jenisDokumen}</td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>{r.tanggal}</td>
                        <td style={{ ...td, maxWidth: 220 }}>{r.paraPihak}</td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>{r.nilai}</td>
                        <td style={{ ...td, maxWidth: 320 }}>{r.status === "gagal" ? (r.reason ?? "Gagal diproses") : r.poinKunci}</td>
                        <td style={{ ...td, maxWidth: 280 }}>{r.relevansi}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const td: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 12,
  lineHeight: 1.55,
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border-color)",
  verticalAlign: "top",
};

const btnSmall: React.CSSProperties = {
  padding: "5px 12px",
  background: "transparent",
  border: "1px solid var(--border-color)",
  borderRadius: 3,
  color: "var(--text-muted)",
  fontSize: 12,
  cursor: "pointer",
};
