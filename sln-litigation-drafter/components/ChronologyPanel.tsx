"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { ChronologyConflict, ChronologyData, ChronologyEvent } from "@/types";

type ChronologyMessage =
  | { type: "start"; total: number }
  | { type: "doc"; index: number; total: number; file: string; eventsFound: number; error?: string }
  | { type: "events"; events: ChronologyEvent[] }
  | { type: "conflicts"; conflicts: ChronologyConflict[] }
  | { type: "warning"; message: string }
  | { type: "done"; events: ChronologyEvent[]; conflicts: ChronologyConflict[] }
  | { type: "error"; message: string };

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function sortKey(e: ChronologyEvent): string {
  if (!e.tanggalISO || !/^\d{4}/.test(e.tanggalISO)) return "9999-99-99";
  const [y, m = "00", d = "00"] = e.tanggalISO.split("-");
  return `${y}-${m}-${d}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Render the chronology as formal Indonesian prose for the Stage 3A kronologi
// field (which feeds the drafting pipeline).
function toKronologiText(events: ChronologyEvent[]): string {
  return events
    .map((e) => {
      const tanggal = e.tanggalTeks !== "—" ? e.tanggalTeks : e.tanggalISO ?? "tanggal tidak disebutkan";
      return `- ${tanggal}: ${e.peristiwa}${e.pelaku !== "—" ? ` (${e.pelaku})` : ""} [sumber: ${e.sumber}]`;
    })
    .join("\n");
}

// Self-contained HTML timeline for sharing outside the app (Harvey-style
// downloadable visualization). Inline CSS only — must open anywhere.
function buildTimelineHtml(ref: string, events: ChronologyEvent[], conflicts: ChronologyConflict[]): string {
  const conflictIds = new Set(conflicts.flatMap((c) => c.eventIds));
  const items = events
    .map((e) => {
      const flagged = conflictIds.has(e.id);
      return `<li style="margin:0 0 18px;padding:0 0 0 18px;border-left:2px solid ${flagged ? "#a83226" : "#c8c2b6"};position:relative">
<span style="position:absolute;left:-6px;top:4px;width:10px;height:10px;border-radius:50%;background:${flagged ? "#a83226" : "#7c3626"}"></span>
<div style="font-size:13px;font-weight:700;color:#7c3626">${esc(e.tanggalTeks !== "—" ? e.tanggalTeks : e.tanggalISO ?? "Tanpa tanggal")}${flagged ? ' <span style="color:#a83226">⚠ konflik</span>' : ""}</div>
<div style="font-size:14px;color:#211d18;margin:2px 0">${esc(e.peristiwa)}${e.pelaku !== "—" ? ` <em style="color:#6e675d">(${esc(e.pelaku)})</em>` : ""}</div>
<div style="font-size:12px;color:#6e675d">Sumber: ${esc(e.sumber)}${e.kutipan ? ` — &ldquo;${esc(e.kutipan)}&rdquo;` : ""}</div>
</li>`;
    })
    .join("\n");
  const conflictHtml = conflicts.length
    ? `<h2 style="font-size:16px;color:#a83226;margin:28px 0 10px">Inkonsistensi yang perlu diperiksa (${conflicts.length})</h2><ol style="padding-left:20px">` +
      conflicts
        .map((c) => {
          const label = c.jenis === "tanggal_bertentangan" ? "Tanggal bertentangan" : c.jenis === "fakta_bertentangan" ? "Fakta bertentangan" : "Kemungkinan duplikat";
          return `<li style="font-size:13px;color:#211d18;margin-bottom:8px"><strong>${label}:</strong> ${esc(c.penjelasan)}</li>`;
        })
        .join("\n") +
      `</ol>`
    : "";
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kronologi — ${esc(ref || "Perkara")}</title></head>
<body style="font-family:Georgia,'Times New Roman',serif;background:#faf8f5;margin:0;padding:32px 16px">
<div style="max-width:720px;margin:0 auto">
<h1 style="font-size:22px;color:#211d18;margin:0 0 4px">Kronologi Perkara</h1>
<p style="font-size:13px;color:#6e675d;margin:0 0 24px">${esc(ref || "")} — dibuat ${new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })} — draf AI, wajib diverifikasi</p>
<ul style="list-style:none;margin:0;padding:0">${items}</ul>
${conflictHtml}
</div></body></html>`;
}

export default function ChronologyPanel({ onUseAsKronologi }: { onUseAsKronologi?: (text: string) => void }) {
  const { state, dispatch } = useWorkflow();
  const data: ChronologyData = state.chronology ?? { events: [], conflicts: [] };

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const checkedStored = useRef(false);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Load a previously persisted chronology (fresh tab / resume).
  useEffect(() => {
    if (checkedStored.current || data.events.length > 0 || !state.sessionId) return;
    checkedStored.current = true;
    fetch(`/api/analyze/chronology?sessionId=${encodeURIComponent(state.sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { events?: ChronologyEvent[]; conflicts?: ChronologyConflict[] } | null) => {
        if (d?.events?.length) {
          dispatch({ type: "SET_CHRONOLOGY", data: { events: d.events, conflicts: d.conflicts ?? [] } });
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setError("");
    setWarnings([]);
    setProgress(null);
    setApplied(false);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const collected: ChronologyEvent[] = [];
    let docsDone = 0;
    let sawDone = false;
    try {
      const res = await fetch("/api/analyze/chronology", {
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
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || `Gagal membuat kronologi (HTTP ${res.status})`);
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
          let msg: ChronologyMessage;
          try {
            msg = JSON.parse(line) as ChronologyMessage;
          } catch {
            continue;
          }
          if (msg.type === "start") {
            setProgress({ done: 0, total: msg.total });
          } else if (msg.type === "doc") {
            docsDone++;
            setProgress({ done: docsDone, total: msg.total });
          } else if (msg.type === "events") {
            collected.push(...msg.events);
            const sorted = [...collected].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
            dispatch({ type: "SET_CHRONOLOGY", data: { events: sorted, conflicts: [] } });
          } else if (msg.type === "warning") {
            setWarnings((w) => [...w, msg.message]);
          } else if (msg.type === "conflicts") {
            // final ordering + conflicts arrive just before done
          } else if (msg.type === "done") {
            sawDone = true;
            dispatch({ type: "SET_CHRONOLOGY", data: { events: msg.events, conflicts: msg.conflicts } });
            if (state.folderPath) {
              fetch("/api/sharepoint/save-matter-file", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  folderPath: state.folderPath,
                  filename: `AI/chronology_${ts()}.json`,
                  content: JSON.stringify({ ref: state.ref, events: msg.events, conflicts: msg.conflicts, timestamp: new Date().toISOString() }),
                }),
              }).catch(() => {});
            }
          } else if (msg.type === "error") {
            throw new Error(msg.message);
          }
        }
      }
      if (!sawDone && collected.length === 0) {
        throw new Error("Koneksi terputus sebelum kronologi selesai — coba lagi.");
      }
      if (!sawDone) {
        setWarnings((w) => [...w, "Koneksi terputus sebelum semua dokumen diproses — kronologi parsial ditampilkan (tanpa pemeriksaan konflik)."]);
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Terjadi kesalahan saat membuat kronologi");
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  }

  function downloadHtml() {
    const html = buildTimelineHtml(state.ref, displayEvents, data.conflicts);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(state.ref || "kronologi").replace(/[\\/"]/g, "-")}_kronologi.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const sources = Array.from(new Set(data.events.map((e) => e.sumber)));
  const displayEvents = sourceFilter ? data.events.filter((e) => e.sumber === sourceFilter) : data.events;
  const conflictIds = new Set(data.conflicts.flatMap((c) => c.eventIds));
  const eventById = new Map(data.events.map((e) => [e.id, e]));

  return (
    <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 4, marginBottom: 24 }}>
      <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: collapsed ? "none" : "1px solid var(--border-color)", flexWrap: "wrap" }}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          style={{ background: "none", border: "none", color: "var(--text-primary)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}
        >
          {collapsed ? "▸" : "▾"} Kronologi Lintas Dokumen
        </button>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {data.events.length > 0
            ? `${data.events.length} peristiwa${data.conflicts.length > 0 ? ` — ${data.conflicts.length} inkonsistensi` : ""}`
            : "timeline peristiwa dari semua dokumen + deteksi konflik"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {data.events.length > 0 && (
            <>
              <button onClick={downloadHtml} style={btnSmall}>⬇ Timeline HTML</button>
              {onUseAsKronologi && (
                <button
                  onClick={() => {
                    onUseAsKronologi(toKronologiText(data.events));
                    setApplied(true);
                  }}
                  style={{ ...btnSmall, borderColor: applied ? "var(--accent-blue)" : "var(--border-color)", color: applied ? "var(--accent-blue)" : "var(--text-muted)" }}
                >
                  {applied ? "✓ Diterapkan ke Kronologi" : "Gunakan sebagai Kronologi"}
                </button>
              )}
            </>
          )}
          <button onClick={generate} disabled={generating} style={{ ...btnSmall, opacity: generating ? 0.5 : 1 }}>
            {generating
              ? `Memproses${progress ? ` ${progress.done}/${progress.total}` : ""}...`
              : data.events.length > 0
              ? "↻ Buat Ulang"
              : "Buat Kronologi"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div style={{ padding: "12px 16px 16px" }}>
          {error && (
            <div style={{ padding: 12, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 12 }}>
              {error}
              <button onClick={generate} style={{ marginLeft: 10, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>
                Coba lagi
              </button>
            </div>
          )}
          {warnings.map((w, i) => (
            <div key={i} style={{ padding: 10, background: "rgba(184,134,11,0.1)", border: "1px solid var(--accent-gold)", borderRadius: 4, color: "var(--accent-gold)", fontSize: 12, marginBottom: 8 }}>
              {w}
            </div>
          ))}

          {data.events.length === 0 && !generating && !error && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              Ekstrak semua peristiwa bertanggal dari seluruh dokumen, urutkan menjadi satu timeline dengan kutipan
              sumber per peristiwa, dan tandai tanggal/fakta yang saling bertentangan antar dokumen.
            </p>
          )}
          {generating && data.events.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              Mengekstrak peristiwa{progress ? ` (dokumen ${progress.done}/${progress.total})` : ""}...
            </p>
          )}

          {/* Conflict summary */}
          {data.conflicts.length > 0 && (
            <div style={{ border: "1px solid var(--error)", borderRadius: 4, marginBottom: 14 }}>
              <div style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600, color: "var(--error)", borderBottom: "1px solid var(--error)" }}>
                ⚠ {data.conflicts.length} INKONSISTENSI LINTAS DOKUMEN — periksa sebelum drafting
              </div>
              <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                {data.conflicts.map((c, i) => (
                  <div key={i} style={{ fontSize: 12, color: "var(--text-primary)", lineHeight: 1.6 }}>
                    <strong style={{ color: "var(--error)" }}>
                      {c.jenis === "tanggal_bertentangan" ? "Tanggal bertentangan" : c.jenis === "fakta_bertentangan" ? "Fakta bertentangan" : "Kemungkinan duplikat"}:
                    </strong>{" "}
                    {c.penjelasan}
                    <span style={{ color: "var(--text-muted)" }}>
                      {" "}({c.eventIds.map((id) => eventById.get(id)?.sumber).filter(Boolean).join(" vs ")})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Source filter */}
          {data.events.length > 0 && sources.length > 1 && (
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              <button onClick={() => setSourceFilter(null)} style={chip(sourceFilter === null)}>Semua sumber</button>
              {sources.map((s) => (
                <button key={s} onClick={() => setSourceFilter(s === sourceFilter ? null : s)} style={chip(sourceFilter === s)} title={s}>
                  {s.length > 28 ? s.slice(0, 26) + "…" : s}
                </button>
              ))}
            </div>
          )}

          {/* Timeline */}
          {displayEvents.length > 0 && (
            <div style={{ maxHeight: 480, overflowY: "auto", paddingRight: 6 }}>
              {displayEvents.map((e) => {
                const flagged = conflictIds.has(e.id);
                return (
                  <div key={e.id} style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border-color)" }}>
                    <div style={{ minWidth: 110, fontSize: 12, fontWeight: 600, color: flagged ? "var(--error)" : "var(--accent-blue)", whiteSpace: "nowrap" }}>
                      {flagged ? "⚠ " : ""}
                      {e.tanggalTeks !== "—" ? e.tanggalTeks : e.tanggalISO ?? "Tanpa tanggal"}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.55 }}>
                        {e.peristiwa}
                        {e.pelaku !== "—" && <span style={{ color: "var(--text-muted)" }}> — {e.pelaku}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }} title={e.kutipan}>
                        {e.sumber}
                        {e.kutipan ? ` — “${e.kutipan.slice(0, 120)}${e.kutipan.length > 120 ? "…" : ""}”` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const btnSmall: React.CSSProperties = {
  padding: "5px 12px",
  background: "transparent",
  border: "1px solid var(--border-color)",
  borderRadius: 3,
  color: "var(--text-muted)",
  fontSize: 12,
  cursor: "pointer",
};

const chip = (active: boolean): React.CSSProperties => ({
  padding: "3px 10px",
  fontSize: 11,
  borderRadius: 12,
  border: `1px solid ${active ? "var(--accent-blue)" : "var(--border-color)"}`,
  background: active ? "var(--accent-blue)" : "transparent",
  color: active ? "white" : "var(--text-muted)",
  cursor: "pointer",
});
