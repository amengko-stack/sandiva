"use client";

import { useState } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import { CheckIcon, DownloadIcon, CloudIcon, BookmarkIcon } from "lucide-react";

export default function Stage5Output() {
  const { state, dispatch, goToStage } = useWorkflow();

  const [sharepointPath, setSharepointPath] = useState(
    state.folderPath ? `${state.folderPath}/Draf` : ""
  );
  const [savingSharepoint, setSavingSharepoint] = useState(false);
  const [sharepointError, setSharepointError] = useState("");
  const [sharepointUrl, setSharepointUrl] = useState("");

  const [approvingMemory, setApprovingMemory] = useState(false);
  const [memoryError, setMemoryError] = useState("");

  async function downloadDocx() {
    const res = await fetch("/api/docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draftText: state.draftText,
        ref: state.ref,
        docType: state.docTypeId || "draf",
        claimType: state.claimType || "",
      }),
    });

    if (!res.ok) {
      alert("Gagal mengunduh file.");
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.ref?.replace(/\//g, "-") || "draf-sln"}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function saveToSharePoint() {
    setSavingSharepoint(true);
    setSharepointError("");
    try {
      const filename = `${state.ref?.replace(/\//g, "-") || "draf"}.docx`;
      const res = await fetch("/api/sharepoint-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftText: state.draftText,
          ref: state.ref,
          docType: state.docTypeId,
          claimType: state.claimType,
          remotePath: sharepointPath,
          filename,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menyimpan ke SharePoint");
      setSharepointUrl(data.webUrl || "");
      dispatch({ type: "SET_SAVED_SHAREPOINT", value: true });
    } catch (e: unknown) {
      setSharepointError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setSavingSharepoint(false);
    }
  }

  async function approveForMemory() {
    setApprovingMemory(true);
    setMemoryError("");
    try {
      const res = await fetch("/api/memory/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftText: state.draftText,
          docType: state.docTypeId,
          claimType: state.claimType || "",
          ref: state.ref,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menyimpan ke memory library");
      dispatch({ type: "SET_APPROVED_MEMORY", value: true });
    } catch (e: unknown) {
      setMemoryError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setApprovingMemory(false);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
        Simpan & Unduh
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 32 }}>
        Draf selesai. Unduh sebagai Word, simpan ke SharePoint, atau setujui untuk ditambahkan ke memory library.
      </p>

      {/* Ref info */}
      <div
        style={{
          padding: "12px 16px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-color)",
          borderRadius: 4,
          marginBottom: 24,
          display: "flex",
          gap: 24,
        }}
      >
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Nomor Referensi</div>
          <div style={{ fontSize: 14, color: "var(--text-primary)", fontFamily: "monospace" }}>{state.ref}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Jenis Dokumen</div>
          <div style={{ fontSize: 14, color: "var(--text-primary)" }}>
            {(state.docTypeId || "").replace(/_/g, " ")}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>Panjang Draf</div>
          <div style={{ fontSize: 14, color: "var(--text-primary)" }}>
            {state.draftText.split(/\s+/).filter(Boolean).length} kata
          </div>
        </div>
      </div>

      {/* Action cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* 1. Download */}
        <ActionCard
          icon={<DownloadIcon size={20} />}
          title="Unduh sebagai .docx"
          description="Unduh draf dalam format Microsoft Word siap edit."
          done={false}
        >
          <button
            onClick={downloadDocx}
            style={{
              padding: "9px 20px",
              background: "var(--accent-blue)",
              color: "white",
              border: "none",
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Unduh .docx
          </button>
        </ActionCard>

        {/* 2. Save to SharePoint */}
        <ActionCard
          icon={<CloudIcon size={20} />}
          title="Simpan ke SharePoint"
          description="Simpan file .docx ke folder SharePoint matter."
          done={state.savedToSharePoint}
        >
          {!state.savedToSharePoint ? (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
                  Path Folder Tujuan
                </label>
                <input
                  type="text"
                  value={sharepointPath}
                  onChange={(e) => setSharepointPath(e.target.value)}
                  placeholder="Matters/MAT-2026-001/Documents/Draf"
                />
              </div>
              <button
                onClick={saveToSharePoint}
                disabled={savingSharepoint || !sharepointPath}
                style={{
                  padding: "9px 20px",
                  background: "var(--accent-blue)",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  fontSize: 13,
                  cursor: savingSharepoint ? "wait" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {savingSharepoint ? "Menyimpan..." : "Simpan"}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "var(--success)" }}>
              ✓ Tersimpan ke SharePoint
              {sharepointUrl && (
                <a href={sharepointUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 8, color: "var(--accent-blue)" }}>
                  Buka →
                </a>
              )}
            </div>
          )}
          {sharepointError && (
            <p style={{ color: "var(--error)", fontSize: 12, marginTop: 6 }}>{sharepointError}</p>
          )}
        </ActionCard>

        {/* 3. Approve for memory */}
        <ActionCard
          icon={<BookmarkIcon size={20} />}
          title="Setujui untuk Memory Library"
          description="Tambahkan draf ini sebagai contoh untuk meningkatkan kualitas draf berikutnya."
          done={state.approvedForMemory}
        >
          {!state.approvedForMemory ? (
            <button
              onClick={approveForMemory}
              disabled={approvingMemory}
              style={{
                padding: "9px 20px",
                background: "transparent",
                border: "1px solid var(--accent-gold)",
                color: "var(--accent-gold)",
                borderRadius: 4,
                fontSize: 13,
                cursor: approvingMemory ? "wait" : "pointer",
              }}
            >
              {approvingMemory ? "Menyimpan..." : "Setujui & Simpan ke Memory"}
            </button>
          ) : (
            <div style={{ fontSize: 13, color: "var(--success)" }}>
              ✓ Ditambahkan ke memory library
            </div>
          )}
          {memoryError && (
            <p style={{ color: "var(--error)", fontSize: 12, marginTop: 6 }}>{memoryError}</p>
          )}
        </ActionCard>

      </div>

      {/* New draft */}
      <div style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--border-color)" }}>
        <button
          onClick={() => {
            dispatch({ type: "RESET" });
            goToStage(1);
          }}
          style={{
            padding: "10px 20px",
            background: "transparent",
            border: "1px solid var(--border-color)",
            borderRadius: 4,
            color: "var(--text-muted)",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          + Buat Draf Baru
        </button>
      </div>
    </div>
  );
}

function ActionCard({
  icon,
  title,
  description,
  done,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: done ? "1px solid var(--success)" : "1px solid var(--border-color)",
        borderRadius: 4,
        padding: "20px 24px",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 14 }}>
        <div style={{ color: done ? "var(--success)" : "var(--text-muted)", marginTop: 2 }}>
          {done ? <CheckIcon size={20} /> : icon}
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 500, color: "var(--text-primary)", marginBottom: 3 }}>
            {title}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{description}</div>
        </div>
      </div>
      {children}
    </div>
  );
}
