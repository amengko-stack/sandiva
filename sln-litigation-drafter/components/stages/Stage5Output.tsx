"use client";

import { useState, useEffect, useRef } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import { CheckIcon, DownloadIcon, CloudIcon, BookmarkIcon, ShieldIcon } from "lucide-react";
import type { CitationItem } from "@/types";

export default function Stage5Output() {
  const { state, dispatch, goToStage } = useWorkflow();

  // Citation extraction state
  const [citations, setCitations] = useState<CitationItem[] | null>(null);
  const [citationsLoading, setCitationsLoading] = useState(false);
  const [citationsError, setCitationsError] = useState("");
  const hasFiredCitations = useRef(false);

  // Auto-save state
  const [autoSaveStatus, setAutoSaveStatus] = useState<"pending" | "saved" | "failed" | "idle">("idle");
  const [autoSaveUrl, setAutoSaveUrl] = useState("");
  const hasFiredAutoSave = useRef(false);

  const [approvingMemory, setApprovingMemory] = useState(false);
  const [memoryError, setMemoryError] = useState("");

  // Build the plain-text citation appendix from CitationItem[]
  function buildCitationAppendix(items: CitationItem[]): string {
    const pasal = items.filter((c) => c.type === "pasal_uu");
    const yurisprudensi = items.filter((c) => c.type === "yurisprudensi");

    const lines: string[] = [
      "LAMPIRAN INTERNAL — DAFTAR SITASI UNTUK VERIFIKASI — JANGAN DISERTAKAN DALAM BERKAS YANG DIFILING",
      "",
    ];

    if (pasal.length > 0) {
      lines.push("A. PASAL / UU / PP / PERMA");
      pasal.forEach((c, i) => {
        lines.push(`${i + 1}. ${c.text} — [sumber: ${c.source}]${c.note ? ` — ${c.note}` : ""}`);
      });
      lines.push("");
    }

    if (yurisprudensi.length > 0) {
      lines.push("B. YURISPRUDENSI MAHKAMAH AGUNG");
      yurisprudensi.forEach((c, i) => {
        lines.push(`${i + 1}. ${c.text} — [sumber: ${c.source}]${c.note ? ` — ${c.note}` : ""}`);
      });
      lines.push("");
    }

    if (pasal.length === 0 && yurisprudensi.length === 0) {
      lines.push("Tidak ada sitasi yang ditemukan dalam draf ini.");
    }

    return lines.join("\n");
  }

  async function fetchCitations(): Promise<CitationItem[]> {
    setCitationsLoading(true);
    setCitationsError("");
    try {
      const res = await fetch("/api/citations/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: state.sessionId, draftText: state.draftText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal mengekstrak sitasi");
      const items: CitationItem[] = data.citations ?? [];
      setCitations(items);
      return items;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Terjadi kesalahan";
      setCitationsError(msg);
      return [];
    } finally {
      setCitationsLoading(false);
    }
  }

  function triggerAutoSave(appendix?: string) {
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
        citationAppendix: appendix,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.webUrl) {
          setAutoSaveUrl(data.webUrl);
          setAutoSaveStatus("saved");
          dispatch({ type: "SET_SAVED_SHAREPOINT", value: true });
        } else {
          setAutoSaveStatus("failed");
        }
      })
      .catch(() => setAutoSaveStatus("failed"));
  }

  // On mount: fetch citations first, then trigger auto-save with the appendix
  useEffect(() => {
    if (hasFiredCitations.current) return;
    hasFiredCitations.current = true;

    if (!state.draftText) {
      triggerAutoSave();
      return;
    }

    fetchCitations().then((items) => {
      const appendix = items.length >= 0 ? buildCitationAppendix(items) : undefined;
      triggerAutoSave(appendix);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const appendix = citations ? buildCitationAppendix(citations) : undefined;
    const res = await fetch("/api/docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        draftText: state.draftText,
        ref: state.ref,
        docType: state.docTypeId || "draf",
        claimType: state.claimType || "",
        citationAppendix: appendix,
      }),
    });

    if (!res.ok) {
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

  const needsVerification = citations?.filter((c) => c.source === "perlu verifikasi") ?? [];

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
        Simpan & Unduh
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 32 }}>
        Draf selesai. Unduh sebagai Word, simpan ke SharePoint, atau setujui untuk ditambahkan ke memory library.
      </p>

      {/* Ref info */}
      <div style={{ padding: "12px 16px", background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 4, marginBottom: 24, display: "flex", gap: 24 }}>
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

      {/* ── Citation checklist panel ───────────────────────────────────── */}
      <div style={{ marginBottom: 24, background: "var(--bg-surface)", border: `1px solid ${needsVerification.length > 0 ? "#c0392b" : "var(--border-color)"}`, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: 12 }}>
          <ShieldIcon size={18} color={needsVerification.length > 0 ? "#c0392b" : "var(--text-muted)"} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: needsVerification.length > 0 ? "#c0392b" : "var(--text-primary)" }}>
              Daftar Sitasi — Verifikasi Sebelum Filing
            </div>
            {citations && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                {citations.length} sitasi ditemukan
                {needsVerification.length > 0 && (
                  <span style={{ color: "#c0392b", fontWeight: 500 }}> — {needsVerification.length} perlu verifikasi manual</span>
                )}
              </div>
            )}
          </div>
          {citationsError && (
            <button
              onClick={() => fetchCitations().then((items) => {
                if (!hasFiredAutoSave.current) triggerAutoSave(buildCitationAppendix(items));
              })}
              style={{ fontSize: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer" }}
            >
              Coba lagi
            </button>
          )}
        </div>
        <div style={{ padding: "16px 20px" }}>
          {citationsLoading && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid var(--border-color)", borderTopColor: "var(--accent-blue)", animation: "spin 0.8s linear infinite" }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Mengekstrak dan memverifikasi sitasi...</span>
            </div>
          )}
          {citationsError && !citationsLoading && (
            <p style={{ fontSize: 13, color: "var(--error)", margin: 0 }}>{citationsError}</p>
          )}
          {citations && !citationsLoading && citations.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Tidak ada sitasi yang teridentifikasi dalam draf ini.</p>
          )}
          {citations && !citationsLoading && citations.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Pasal / UU group */}
              {citations.filter((c) => c.type === "pasal_uu").length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>Pasal / UU</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {citations.filter((c) => c.type === "pasal_uu").map((c, i) => (
                      <CitationRow key={i} item={c} />
                    ))}
                  </div>
                </div>
              )}
              {/* Yurisprudensi MA group */}
              {citations.filter((c) => c.type === "yurisprudensi").length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>Yurisprudensi Mahkamah Agung</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {citations.filter((c) => c.type === "yurisprudensi").map((c, i) => (
                      <CitationRow key={i} item={c} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {citations && citations.length > 0 && (
          <div style={{ padding: "10px 20px", borderTop: "1px solid var(--border-color)", fontSize: 11, color: "var(--text-muted)" }}>
            Daftar ini dilampirkan secara otomatis sebagai halaman terakhir dalam file .docx (LAMPIRAN INTERNAL — dapat dihapus sebelum filing).
          </div>
        )}
      </div>

      {/* Action cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* 1. Download */}
        <ActionCard
          icon={<DownloadIcon size={20} />}
          title="Unduh sebagai .docx"
          description="Unduh draf dalam format Microsoft Word siap edit. Lampiran sitasi disertakan sebagai halaman terakhir."
          done={false}
        >
          <button
            onClick={downloadDocx}
            style={{ padding: "9px 20px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
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
              style={{ padding: "9px 20px", background: "transparent", border: "1px solid var(--accent-gold)", color: "var(--accent-gold)", borderRadius: 4, fontSize: 13, cursor: approvingMemory ? "wait" : "pointer" }}
            >
              {approvingMemory ? "Menyimpan..." : "Setujui & Simpan ke Memory"}
            </button>
          ) : (
            <div style={{ fontSize: 13, color: "var(--success)" }}>✓ Ditambahkan ke memory library</div>
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
          style={{ padding: "10px 20px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}
        >
          + Buat Draf Baru
        </button>
      </div>
    </div>
  );
}

function CitationRow({ item }: { item: CitationItem }) {
  const isRed = item.source === "perlu verifikasi";
  const badgeColor = isRed ? "#c0392b" : item.source === "konvensi firma" ? "#27ae60" : "#2980b9";
  const badgeBg = isRed ? "rgba(192,57,43,0.12)" : item.source === "konvensi firma" ? "rgba(39,174,96,0.12)" : "rgba(41,128,185,0.12)";

  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 10,
      padding: "7px 10px",
      borderRadius: 4,
      background: isRed ? "rgba(192,57,43,0.06)" : "transparent",
      border: isRed ? "1px solid rgba(192,57,43,0.25)" : "1px solid transparent",
    }}>
      <span style={{ fontSize: 13, color: isRed ? "#c0392b" : "var(--text-primary)", flex: 1, lineHeight: 1.5 }}>
        {isRed && <strong>[PERLU VERIFIKASI] </strong>}{item.text}
        {item.note && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 12 }}>— {item.note}</span>}
      </span>
      <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 10, background: badgeBg, color: badgeColor, whiteSpace: "nowrap", fontWeight: 500 }}>
        {item.source}
      </span>
    </div>
  );
}

function ActionCard({
  icon, title, description, done, children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: "var(--bg-surface)", border: done ? "1px solid var(--success)" : "1px solid var(--border-color)", borderRadius: 4, padding: "20px 24px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 14 }}>
        <div style={{ color: done ? "var(--success)" : "var(--text-muted)", marginTop: 2 }}>
          {done ? <CheckIcon size={20} /> : icon}
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 500, color: "var(--text-primary)", marginBottom: 3 }}>{title}</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{description}</div>
        </div>
      </div>
      {children}
    </div>
  );
}
