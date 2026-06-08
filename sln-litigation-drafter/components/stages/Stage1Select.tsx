"use client";

import { useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import {
  CLAIM_TYPES,
  getClaimTypesForForum,
  getForumDocTypes,
  generateRef,
} from "@/config/documentTypes";

export default function Stage1Select() {
  const { state, dispatch, goToStage } = useWorkflow();

  const [forumId,   setForumId]   = useState(state.practiceAreaId || "");
  const [claimType, setClaimType] = useState(state.claimType      || "");
  const [docTypeId, setDocTypeId] = useState(state.docTypeId      || "");
  const [pihak,     setPihak]     = useState(state.pihak          || "");

  const claimTypes = forumId ? getClaimTypesForForum(forumId) : [];
  const docTypes   = forumId && claimType ? getForumDocTypes(forumId, claimType) : [];
  const selectedDocType = docTypes.find((d) => d.id === docTypeId);
  const needsPihak = selectedDocType?.hasPihak ?? false;

  const canProceed = !!(forumId && claimType && docTypeId && (!needsPihak || pihak));

  function handleForumChange(id: string) {
    setForumId(id);
    setClaimType("");
    setDocTypeId("");
    setPihak("");
  }

  function handleClaimTypeChange(id: string) {
    setClaimType(id);
    setDocTypeId("");
    setPihak("");
  }

  function handleDocTypeChange(id: string) {
    setDocTypeId(id);
    setPihak("");
  }

  function handleProceed() {
    const ref = generateRef(docTypeId);
    dispatch({
      type: "SET_SELECTION",
      practiceAreaId: forumId,
      docTypeId,
      claimType: claimType || null,
      pihak: pihak || null,
    });
    dispatch({ type: "SET_REF", ref });
    goToStage(2);
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
        Pilih Jenis Dokumen
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 32 }}>
        Pilih forum, jenis gugatan, dan jenis dokumen yang akan dibuat.
      </p>

      {/* ── Step 1: Forum ────────────────────────────────────────────────── */}
      <SectionLabel>Forum Pengadilan / Arbitrase</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 28 }}>
        {CLAIM_TYPES.map((forum) => (
          <RadioCard key={forum.id} selected={forumId === forum.id} onClick={() => handleForumChange(forum.id)}>
            <span style={{ fontSize: 14, fontWeight: forumId === forum.id ? 500 : 400, color: forumId === forum.id ? "var(--text-primary)" : "var(--text-muted)" }}>
              {forum.label}
            </span>
          </RadioCard>
        ))}
      </div>

      {/* ── Step 2: Jenis Gugatan ─────────────────────────────────────────── */}
      {forumId && claimTypes.length > 0 && (
        <>
          <SectionLabel>Jenis Gugatan / Klaim</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
            {claimTypes.map((ct) => (
              <RadioCard key={ct.id} selected={claimType === ct.id} onClick={() => handleClaimTypeChange(ct.id)}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: claimType === ct.id ? 500 : 400, color: claimType === ct.id ? "var(--text-primary)" : "var(--text-muted)" }}>
                    {ct.label}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, opacity: 0.75 }}>
                    {ct.statute}
                  </div>
                </div>
              </RadioCard>
            ))}
          </div>
        </>
      )}

      {/* ── Step 3: Jenis Dokumen ─────────────────────────────────────────── */}
      {forumId && claimType && docTypes.length > 0 && (
        <>
          <SectionLabel>Jenis Dokumen</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 28 }}>
            {docTypes.map((dt) => (
              <RadioCard key={dt.id} selected={docTypeId === dt.id} onClick={() => handleDocTypeChange(dt.id)}>
                <span style={{ fontSize: 14, fontWeight: docTypeId === dt.id ? 500 : 400, color: docTypeId === dt.id ? "var(--text-primary)" : "var(--text-muted)" }}>
                  {dt.label}
                </span>
              </RadioCard>
            ))}
          </div>
        </>
      )}

      {/* ── Step 4: Pihak ────────────────────────────────────────────────── */}
      {needsPihak && (
        <>
          <SectionLabel>Pihak yang Diwakili</SectionLabel>
          <div style={{ display: "flex", gap: 12, marginBottom: 28 }}>
            {[
              { id: "penggugat", label: "Penggugat / Pemohon" },
              { id: "tergugat",  label: "Tergugat / Termohon" },
            ].map((p) => (
              <RadioCard key={p.id} selected={pihak === p.id} onClick={() => setPihak(p.id)} flex>
                <span style={{ fontSize: 14, color: pihak === p.id ? "var(--text-primary)" : "var(--text-muted)" }}>
                  {p.label}
                </span>
              </RadioCard>
            ))}
          </div>
        </>
      )}

      <button
        onClick={handleProceed}
        disabled={!canProceed}
        style={{
          padding: "12px 32px",
          background: canProceed ? "var(--accent-blue)" : "var(--border-color)",
          color: "white",
          border: "none",
          borderRadius: 4,
          fontSize: 14,
          fontWeight: 500,
          cursor: canProceed ? "pointer" : "not-allowed",
          marginTop: 8,
        }}
      >
        Lanjut ke Pemilihan File →
      </button>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <label style={{
      display: "block",
      fontSize: 13,
      fontWeight: 500,
      color: "var(--text-muted)",
      marginBottom: 12,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
    }}>
      {children}
    </label>
  );
}

function RadioCard({
  selected,
  onClick,
  children,
  flex,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  flex?: boolean;
}) {
  return (
    <div
      className={`radio-card ${selected ? "selected" : ""}`}
      style={{ cursor: "pointer", ...(flex ? { flex: 1 } : {}) }}
      onClick={onClick}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          flexShrink: 0,
          border: selected ? "5px solid var(--accent-blue)" : "2px solid var(--border-color)",
        }} />
        {children}
      </div>
    </div>
  );
}
