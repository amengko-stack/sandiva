"use client";

import { useState, useEffect, useRef } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import { CheckIcon, DownloadIcon, CloudIcon, BookmarkIcon } from "lucide-react";

export default function Stage5Output() {
  const { state, dispatch, goToStage } = useWorkflow();

  const [autoSaveStatus, setAutoSaveStatus] = useState<"pending" | "saved" | "failed" | "idle">("idle");
  const [autoSaveUrl, setAutoSaveUrl] = useState("");
  const hasFiredAutoSave = useRef(false);

  useEffect(() => {
    if (hasFiredAutoSave.current || !state.folderPath || !state.draftText) return;
    hasFiredAutoSave.current = true;

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `Drafts/${(state.ref || "draf").replace(/\//g, "-")}_${ts}.docx`;
    setAutoSaveStatus("pending");

    fetch("/api/sharepoint-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draftText: state.draftText,
        ref: state.ref,
        docType: state.docTypeId,
        claimType: state.claimType,
        folderPath: state.folderPath,
        filename,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.webUrl) { setAutoSaveUrl(data.webUrl); setAutoSaveStatus("saved"); dispatch({ type: "SET_SAVED_SHAREPOINT", value: true }); }
        else setAutoSaveStatus("failed");
      })
      .catch(() => setAutoSaveStatus("failed"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [sharepointError] = useState("");

  const [approvingMemory, setApprovingMemory] = useState(false);
  const [memoryError, setMemoryError] = useState("");

  async function clearSession() {
    if (!state.sessionId) return;
    try {
      await fetch("/api/session/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId }),
      });
    } catch {}
  }

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
      // Surface the server's actual error instead of a generic alert
      const bodyText = await res.text().catch(() => "");
      console.error(`[stage5] /api/docx status=${res.status} draftChars=${state.draftText.length} body=${bodyText.slice(0, 1000)}`);
      let detail = bodyText.slice(0, 300);
      try { detail = (JSON.parse(bodyText) as { error?: string }).error ?? detail; } catch {}
      alert(`Gagal mengunduh file (${res.status}): ${detail}`);
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

    // Clean up session Blob data after download
    clearSession();
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

        {/* 2. Save to SharePoint (auto) */}
        <ActionCard
          icon={<CloudIcon size={20} />}
          title="Simpan ke SharePoint"
          description={`Draf disimpan otomatis ke ${state.folderPath ? state.folderPath + "/Drafts/" : "folder Drafts"}.`}
          done={state.savedToSharePoint}
        >
          {autoSaveStatus === "pending" && (
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Menyimpan draf ke SharePoint...</span>
          )}
          {autoSaveStatus === "saved" && (
            <span style={{ fontSize: 13, color: "var(--success)" }}>
              ✓ Draf tersimpan
              {autoSaveUrl && (
                <a href={autoSaveUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 8, color: "var(--accent-blue)" }}>
                  Buka →
                </a>
              )}
            </span>
          )}
          {autoSaveStatus === "failed" && (
            <span style={{ fontSize: 13, color: "var(--error)" }}>Gagal menyimpan ke SharePoint</span>
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
            clearSession();
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
