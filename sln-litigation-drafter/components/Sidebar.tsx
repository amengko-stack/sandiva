"use client";

import { useWorkflow } from "@/context/WorkflowContext";
import { findDocType, resolveForumLabel, getClaimTypeLabel } from "@/config/documentTypes";
import { CheckIcon } from "lucide-react";

const STAGES = [
  { num: 1, label: "Pilih Dokumen" },
  { num: 2, label: "File SharePoint" },
  { num: 3, label: "Analisis Perkara" },
  { num: 4, label: "Buat Draf" },
  { num: 5, label: "Simpan & Unduh" },
] as const;

export default function Sidebar() {
  const { state } = useWorkflow();
  const { stage, practiceAreaId, docTypeId } = state;

  const areaLabel = practiceAreaId ? resolveForumLabel(practiceAreaId) : null;
  const docType =
    practiceAreaId && docTypeId
      ? findDocType(practiceAreaId, docTypeId)
      : null;


  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <aside
      style={{
        width: 220,
        minWidth: 220,
        background: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border-color)",
        display: "flex",
        flexDirection: "column",
        height: "100vh",
      }}
    >
      {/* Logo */}
      <div
        style={{
          padding: "24px 20px 20px",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            letterSpacing: "0.15em",
            color: "var(--accent-gold)",
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          SANDIVA LEGAL NETWORK
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-muted)",
            letterSpacing: "0.05em",
          }}
        >
          Litigation Drafter
        </div>
      </div>

      {/* Stage list */}
      <nav style={{ padding: "20px 0", flex: 1 }}>
        {STAGES.map((s) => {
          const isCompleted = stage > s.num;
          const isActive = stage === s.num;
          const isPending = stage < s.num;

          return (
            <div
              key={s.num}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 20px",
                background: isActive
                  ? "rgba(91, 155, 213, 0.08)"
                  : "transparent",
                borderLeft: isActive
                  ? "2px solid var(--accent-blue)"
                  : "2px solid transparent",
              }}
            >
              <div
                className="stage-badge"
                style={{
                  background: isCompleted
                    ? "var(--accent-blue)"
                    : "transparent",
                  border: isCompleted
                    ? "none"
                    : isActive
                    ? "2px solid var(--accent-blue)"
                    : "2px solid var(--border-color)",
                  color: isCompleted
                    ? "white"
                    : isActive
                    ? "var(--accent-blue)"
                    : "var(--text-muted)",
                  flexShrink: 0,
                }}
              >
                {isCompleted ? (
                  <CheckIcon size={12} />
                ) : (
                  s.num
                )}
              </div>
              <span
                style={{
                  fontSize: 13,
                  color: isActive
                    ? "var(--text-primary)"
                    : isPending
                    ? "var(--text-muted)"
                    : "var(--text-primary)",
                  fontWeight: isActive ? 500 : 400,
                }}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </nav>

      {/* Current selection info */}
      {(areaLabel || docType) && (
        <div
          style={{
            padding: "16px 20px",
            borderTop: "1px solid var(--border-color)",
            borderBottom: "1px solid var(--border-color)",
          }}
        >
          {areaLabel && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              {areaLabel}
            </div>
          )}
          {docType && (
            <div style={{ fontSize: 13, color: "var(--accent-gold)", fontWeight: 500 }}>
              {docType.label}
            </div>
          )}
          {state.claimType && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {getClaimTypeLabel(state.claimType)}
            </div>
          )}
          {state.ref && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, fontFamily: "monospace" }}>
              {state.ref}
            </div>
          )}
        </div>
      )}

      {/* Logout */}
      <div style={{ padding: "16px 20px" }}>
        <button
          onClick={handleLogout}
          style={{
            width: "100%",
            padding: "8px 12px",
            background: "transparent",
            border: "1px solid var(--border-color)",
            borderRadius: 4,
            color: "var(--text-muted)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Keluar
        </button>
      </div>
    </aside>
  );
}
