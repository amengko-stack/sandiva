"use client";

import type { ExtractReport } from "@/types";

// Coverage meter: how much of the data room the analysis actually saw.
export default function DDCoveragePanel({ report }: { report: ExtractReport | null }) {
  if (!report) return null;
  const total = report.files.length;
  const pct = total ? Math.round((report.processed / total) * 100) : 0;

  // Per-status breakdown so a 41% coverage is never a mystery — the lawyer
  // sees exactly how many docs failed vs. need external OCR.
  let selesai = 0;
  let gagal = 0;
  let perluOcr = 0;
  for (const f of report.files) {
    if (f.status === "selesai") selesai++;
    else if (f.status === "gagal") gagal++;
    else if (f.status === "perlu_ocr") perluOcr++;
  }
  const problemFiles = report.files.filter((f) => f.status !== "selesai");

  return (
    <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, display: "grid", gap: 6 }}>
      <div style={{ fontWeight: 600 }}>Cakupan ekstraksi: {report.processed}/{total} dokumen ({pct}%)</div>
      <div style={{ height: 8, background: "#f3f4f6", borderRadius: 4 }}>
        <div style={{ height: 8, width: `${pct}%`, background: pct === 100 ? "#059669" : "#f59e0b", borderRadius: 4 }} />
      </div>
      <div style={{ fontSize: 13, color: "var(--text-primary)" }}>
        ✓ {selesai} selesai · ✗ {gagal} gagal · ⚠ {perluOcr} perlu OCR
        {report.cacheHits ? ` · ⚡ ${report.cacheHits} dari cache` : ""}
      </div>
      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
        Total {Math.round(report.totalChars / 1000)} ribu karakter.
      </div>
      {report.processed < total && (
        <div style={{ fontSize: 13, background: "#fef3c7", color: "#78350f", borderRadius: 4, padding: "6px 10px" }}>
          {total - report.processed} dokumen belum masuk analisis.
          {gagal > 0 ? " Coba ulang yang gagal." : ""}
          {perluOcr > 0 ? " Untuk dokumen pindaian, jalankan OCR eksternal lalu gunakan Folder hasil OCR di bawah." : ""}
        </div>
      )}
      {problemFiles.length > 0 && (
        <details>
          <summary>Dokumen bermasalah ({problemFiles.length})</summary>
          <ul>
            {problemFiles.map((f, i) => (
              <li key={i}>{f.name} — {f.status}{f.reason ? `: ${f.reason}` : ""}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
