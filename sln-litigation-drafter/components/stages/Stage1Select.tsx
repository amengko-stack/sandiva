"use client";

import { useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import { PRACTICE_AREAS, generateRef } from "@/config/documentTypes";

export default function Stage1Select() {
  const { state, dispatch, goToStage } = useWorkflow();

  const [practiceAreaId, setPracticeAreaId] = useState(
    state.practiceAreaId || ""
  );
  const [docTypeId, setDocTypeId] = useState(state.docTypeId || "");
  const [claimType, setClaimType] = useState(state.claimType || "");
  const [pihak, setPihak] = useState(state.pihak || "");

  const selectedArea = PRACTICE_AREAS.find((a) => a.id === practiceAreaId);
  const selectedDocType = selectedArea?.docTypes.find(
    (d) => d.id === docTypeId
  );

  const needsClaimType =
    selectedDocType && selectedDocType.claimTypes.length > 0;
  const needsPihak = selectedDocType?.hasPihak;

  const canProceed =
    practiceAreaId &&
    docTypeId &&
    (!needsClaimType || claimType) &&
    (!needsPihak || pihak);

  function handleProceed() {
    const ref = generateRef(docTypeId);
    dispatch({
      type: "SET_SELECTION",
      practiceAreaId,
      docTypeId,
      claimType: claimType || null,
      pihak: pihak || null,
    });
    dispatch({ type: "SET_REF", ref });
    goToStage(2);
  }

  function handlePracticeAreaChange(id: string) {
    setPracticeAreaId(id);
    setDocTypeId("");
    setClaimType("");
    setPihak("");
  }

  return (
    <div>
      <h1
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: "var(--text-primary)",
          marginBottom: 8,
        }}
      >
        Pilih Jenis Dokumen
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 32 }}>
        Pilih bidang hukum dan jenis dokumen yang akan dibuat.
      </p>

      {/* Practice Area */}
      <div style={{ marginBottom: 28 }}>
        <label
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 500,
            color: "var(--text-muted)",
            marginBottom: 12,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          Bidang Hukum
        </label>
        <div style={{ display: "flex", gap: 12 }}>
          {PRACTICE_AREAS.map((area) => (
            <div
              key={area.id}
              className={`radio-card ${practiceAreaId === area.id ? "selected" : ""}`}
              style={{ flex: 1, cursor: "pointer" }}
              onClick={() => handlePracticeAreaChange(area.id)}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    border:
                      practiceAreaId === area.id
                        ? "5px solid var(--accent-blue)"
                        : "2px solid var(--border-color)",
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 14,
                    color:
                      practiceAreaId === area.id
                        ? "var(--text-primary)"
                        : "var(--text-muted)",
                    fontWeight: practiceAreaId === area.id ? 500 : 400,
                  }}
                >
                  {area.label}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Doc Type */}
      {selectedArea && (
        <div style={{ marginBottom: 28 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--text-muted)",
              marginBottom: 12,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Jenis Dokumen
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {selectedArea.docTypes.map((dt) => (
              <div
                key={dt.id}
                className={`radio-card ${docTypeId === dt.id ? "selected" : ""}`}
                style={{ cursor: "pointer" }}
                onClick={() => {
                  setDocTypeId(dt.id);
                  setClaimType("");
                  setPihak("");
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      border:
                        docTypeId === dt.id
                          ? "5px solid var(--accent-blue)"
                          : "2px solid var(--border-color)",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 14,
                      color:
                        docTypeId === dt.id
                          ? "var(--text-primary)"
                          : "var(--text-muted)",
                      fontWeight: docTypeId === dt.id ? 500 : 400,
                    }}
                  >
                    {dt.label}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Claim Type */}
      {needsClaimType && selectedDocType && (
        <div style={{ marginBottom: 28 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--text-muted)",
              marginBottom: 12,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Dasar Gugatan
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {selectedDocType.claimTypes.map((ct) => (
              <div
                key={ct.id}
                className={`radio-card ${claimType === ct.id ? "selected" : ""}`}
                style={{ cursor: "pointer" }}
                onClick={() => setClaimType(ct.id)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      border:
                        claimType === ct.id
                          ? "5px solid var(--accent-blue)"
                          : "2px solid var(--border-color)",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 14,
                      color:
                        claimType === ct.id
                          ? "var(--text-primary)"
                          : "var(--text-muted)",
                    }}
                  >
                    {ct.label}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pihak */}
      {needsPihak && (
        <div style={{ marginBottom: 28 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 500,
              color: "var(--text-muted)",
              marginBottom: 12,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            Pihak yang Diwakili
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            {[
              { id: "penggugat", label: "Penggugat / Pemohon" },
              { id: "tergugat", label: "Tergugat / Termohon" },
            ].map((p) => (
              <div
                key={p.id}
                className={`radio-card ${pihak === p.id ? "selected" : ""}`}
                style={{ flex: 1, cursor: "pointer" }}
                onClick={() => setPihak(p.id)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      border:
                        pihak === p.id
                          ? "5px solid var(--accent-blue)"
                          : "2px solid var(--border-color)",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 14,
                      color:
                        pihak === p.id
                          ? "var(--text-primary)"
                          : "var(--text-muted)",
                    }}
                  >
                    {p.label}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
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
