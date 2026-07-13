"use client";

import type { DDExtractionRow } from "@/types/dd";

export default function DDReviewTable({
  rows, onOpenSource,
}: {
  rows: DDExtractionRow[];
  onOpenSource: (sourceFile: string, verbatim: string) => void;
}) {
  if (rows.length === 0) return null;
  // Column union across rows, keeping first-seen order.
  const fieldIds: string[] = [];
  for (const r of rows) for (const c of r.cells) if (!fieldIds.includes(c.fieldId)) fieldIds.push(c.fieldId);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 800 }}>
        <thead>
          <tr>
            <th style={{ padding: 6, textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>Perjanjian</th>
            {fieldIds.map((id) => (
              <th key={id} style={{ padding: 6, textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>{id.replace(/_/g, " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.groupId} style={{ borderBottom: "1px solid #f3f4f6", verticalAlign: "top" }}>
              <td style={{ padding: 6, fontWeight: 600 }}>
                {r.agreementLabel}
                {r.memberFiles.length > 1 && <div style={{ fontWeight: 400, color: "#6b7280" }}>{r.memberFiles.length} file (induk + addendum)</div>}
                {r.status === "gagal" && <div style={{ color: "#991b1b" }}>GAGAL: {r.reason}</div>}
              </td>
              {fieldIds.map((id) => {
                const c = r.cells.find((x) => x.fieldId === id);
                if (!c) return <td key={id} style={{ padding: 6, color: "#d1d5db" }}>·</td>;
                return (
                  <td
                    key={id}
                    onClick={() => c.verbatim && onOpenSource(c.sourceFile || r.memberFiles[0], c.verbatim)}
                    title={c.verbatim || undefined}
                    style={{
                      padding: 6,
                      cursor: c.verbatim ? "pointer" : "default",
                      background: c.dealTriggered ? "#fee2e2" : undefined,
                      textDecoration: c.verbatim ? "underline dotted" : undefined,
                    }}
                  >
                    {c.dealTriggered ? "⚠ " : ""}{c.value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
