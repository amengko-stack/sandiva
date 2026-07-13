"use client";

import { useState } from "react";
import Link from "next/link";
import { useDD } from "@/context/DDContext";
import DDChecklistManager from "@/components/dd/DDChecklistManager";
import type { DDStage } from "@/types/dd";

const STAGES: { n: DDStage; label: string }[] = [
  { n: 1, label: "Transaksi & Entitas" },
  { n: 2, label: "Ekstraksi Data Room" },
  { n: 3, label: "Klasifikasi & Gap" },
  { n: 4, label: "Tabel Ketentuan Kunci" },
  { n: 5, label: "Temuan & Review" },
  { n: 6, label: "Ekspor" },
];

export default function DDSidebar() {
  const { state, dispatch } = useDD();
  const [showChecklist, setShowChecklist] = useState(false);
  return (
    <aside style={{ width: 240, borderRight: "1px solid var(--border, #e5e7eb)", padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Uji Tuntas (LDD)</div>
      {STAGES.map((s) => (
        <button
          key={s.n}
          onClick={() => s.n <= state.stage && dispatch({ type: "SET_STAGE", stage: s.n })}
          disabled={s.n > state.stage}
          style={{
            textAlign: "left", padding: "8px 10px", borderRadius: 6, border: "none",
            cursor: s.n <= state.stage ? "pointer" : "default",
            background: s.n === state.stage ? "var(--accent, #e0e7ff)" : "transparent",
            opacity: s.n > state.stage ? 0.45 : 1,
          }}
        >
          {s.n}. {s.label}
        </button>
      ))}
      <button onClick={() => setShowChecklist(true)} style={{ textAlign: "left", padding: "8px 10px", border: "none", background: "transparent", cursor: "pointer", fontSize: 12 }}>
        ⚙ Kelola checklist
      </button>
      {showChecklist && <DDChecklistManager onClose={() => setShowChecklist(false)} />}
      <div style={{ marginTop: "auto", fontSize: 12 }}>
        <Link href="/">← Menu utama</Link>
      </div>
    </aside>
  );
}
