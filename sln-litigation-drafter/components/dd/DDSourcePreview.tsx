"use client";

import { useEffect, useRef, useState } from "react";

// Preview the CACHED EXTRACTED TEXT of one source document with the anchor
// passage highlighted. V1 previews extracted text, not the original PDF/DOCX.
export default function DDSourcePreview({
  sessionId, entityId, sourceFile, highlight, onClose,
}: {
  sessionId: string; entityId: string; sourceFile: string; highlight: string; onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/dd/check-session?sessionId=${sessionId}&entityId=${entityId}&artifact=extracted&file=${encodeURIComponent(sourceFile)}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Gagal memuat dokumen");
        if (alive) setText(data.content ?? "");
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Error"));
    return () => { alive = false; };
  }, [sessionId, entityId, sourceFile]);

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center" });
  }, [text]);

  // Whitespace-tolerant split: find the highlight even if line breaks differ.
  const parts = (() => {
    if (!text || !highlight.trim()) return null;
    const esc = highlight.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const m = new RegExp(esc, "i").exec(text);
    if (!m) return null;
    return [text.slice(0, m.index), m[0], text.slice(m.index + m[0].length)];
  })();

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, width: "min(560px, 90vw)", height: "100vh",
      background: "#fff", borderLeft: "1px solid #e5e7eb", boxShadow: "-4px 0 12px rgba(0,0,0,.08)",
      padding: 16, overflowY: "auto", zIndex: 50,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>{sourceFile}</strong>
        <button onClick={onClose}>✕ Tutup</button>
      </div>
      {error && <div style={{ color: "#991b1b" }}>{error}</div>}
      {text === null && !error && <div>Memuat…</div>}
      {text !== null && (
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6 }}>
          {parts ? (
            <>
              {parts[0]}
              <mark ref={(el) => { markRef.current = el; }} style={{ background: "#fde68a" }}>{parts[1]}</mark>
              {parts[2]}
            </>
          ) : (
            <>
              {highlight.trim() && <div style={{ background: "#fef3c7", padding: 8, marginBottom: 8 }}>Kutipan tidak ditemukan persis dalam teks ekstraksi — ditampilkan tanpa sorotan.</div>}
              {text}
            </>
          )}
        </pre>
      )}
    </div>
  );
}
