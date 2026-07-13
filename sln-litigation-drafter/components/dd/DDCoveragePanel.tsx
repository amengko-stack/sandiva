"use client";

import type { ExtractReport } from "@/types";

// Coverage meter: how much of the data room the analysis actually saw.
export default function DDCoveragePanel({ report }: { report: ExtractReport | null }) {
  if (!report) return null;
  const total = report.files.length;
  const pct = total ? Math.round((report.processed / total) * 100) : 0;
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, display: "grid", gap: 6 }}>
      <div style={{ fontWeight: 600 }}>Cakupan ekstraksi: {report.processed}/{total} dokumen ({pct}%)</div>
      <div style={{ height: 8, background: "#f3f4f6", borderRadius: 4 }}>
        <div style={{ height: 8, width: `${pct}%`, background: pct === 100 ? "#059669" : "#f59e0b", borderRadius: 4 }} />
      </div>
      <div style={{ fontSize: 13, color: "#6b7280" }}>
        {report.ocrRequired ? `${report.ocrRequired} dokumen pindaian perlu OCR eksternal. ` : ""}
        {report.skipped ? `${report.skipped} dokumen gagal diekstrak. ` : ""}
        {report.cacheHits ? `${report.cacheHits} dari cache. ` : ""}
        Total {Math.round(report.totalChars / 1000)} ribu karakter.
      </div>
      {(report.files.filter((f) => f.status !== "selesai").length > 0) && (
        <details>
          <summary>Dokumen bermasalah</summary>
          <ul>
            {report.files.filter((f) => f.status !== "selesai").map((f, i) => (
              <li key={i}>{f.name} — {f.status}{f.reason ? `: ${f.reason}` : ""}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
