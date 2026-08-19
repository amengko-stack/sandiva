"use client";

import { aspectLabel } from "@/config/ddAspects";
import type { DDGapItem } from "@/types/dd";

const STATUS_STYLE: Record<DDGapItem["status"], { label: string; bg: string; fg: string }> = {
  present: { label: "Ada", bg: "#d1fae5", fg: "#065f46" },
  incomplete: { label: "Tidak lengkap", bg: "#fef3c7", fg: "#78350f" },
  expired: { label: "Kedaluwarsa", bg: "#fed7aa", fg: "#9a3412" },
  missing: { label: "TIDAK ADA", bg: "#fee2e2", fg: "#7f1d1d" },
  // Distinct from missing on purpose: the document was supplied, only unreadable.
  unreadable: { label: "TIDAK TERBACA", bg: "#e0e7ff", fg: "#3730a3" },
  not_applicable: { label: "N/A?", bg: "#e5e7eb", fg: "#374151" },
};

export default function DDGapMatrix({ gaps }: { gaps: DDGapItem[] }) {
  const byAspect = new Map<string, DDGapItem[]>();
  for (const g of gaps) (byAspect.get(g.aspectId) ?? byAspect.set(g.aspectId, []).get(g.aspectId)!).push(g);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {Array.from(byAspect.entries()).map(([aspectId, items]: [string, DDGapItem[]]) => (
        <div key={aspectId}>
          <h3 style={{ margin: "8px 0" }}>{aspectLabel(items[0].aspectId)}</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {items.map((g: DDGapItem) => (
                <tr key={g.expectedDocId} style={{ borderBottom: "1px solid var(--border-color)" }}>
                  <td style={{ padding: 6 }}>{g.expectedLabel}</td>
                  <td style={{ padding: 6, width: 130 }}>
                    <span style={{ background: STATUS_STYLE[g.status].bg, color: STATUS_STYLE[g.status].fg, padding: "2px 8px", borderRadius: 4 }}>
                      {STATUS_STYLE[g.status].label}
                    </span>
                  </td>
                  <td style={{ padding: 6, color: "var(--text-muted)" }}>
                    {g.matchedFiles.length ? g.matchedFiles.join(", ") : g.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
