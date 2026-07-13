"use client";

import { aspectLabel } from "@/config/ddAspects";
import type { DDGapItem } from "@/types/dd";

const STATUS_STYLE: Record<DDGapItem["status"], { label: string; bg: string }> = {
  present: { label: "Ada", bg: "#d1fae5" },
  incomplete: { label: "Tidak lengkap", bg: "#fef3c7" },
  expired: { label: "Kedaluwarsa", bg: "#fed7aa" },
  missing: { label: "TIDAK ADA", bg: "#fee2e2" },
  not_applicable: { label: "N/A?", bg: "#e5e7eb" },
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
                <tr key={g.expectedDocId} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: 6 }}>{g.expectedLabel}</td>
                  <td style={{ padding: 6, width: 130 }}>
                    <span style={{ background: STATUS_STYLE[g.status].bg, padding: "2px 8px", borderRadius: 4 }}>
                      {STATUS_STYLE[g.status].label}
                    </span>
                  </td>
                  <td style={{ padding: 6, color: "#6b7280" }}>
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
