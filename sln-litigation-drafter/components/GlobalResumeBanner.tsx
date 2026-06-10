"use client";

import type { CaseAnalysis, InterviewAnswer, FileEntry, DocMapEntry } from "@/types";

export type GlobalStage2Resume = {
  type: "file_list" | "categorization" | "extraction_progress";
  timestamp: string;
  files?: FileEntry[];
  docMap?: DocMapEntry[];
  selectedFileIds?: string[];
  completedFiles?: { name: string; status: string }[];
  remainingFiles?: FileEntry[];
  processed?: number;
  totalChars?: number;
};

export type GlobalResumeData = {
  found: boolean;
  latestTimestamp?: string;
  analysis?: CaseAnalysis;
  kronologi?: string;
  interviewAnswers?: InterviewAnswer[];
  strategicAssessment?: string;
  resumeAtStage?: 3 | 4;
  resumeAtSubstep?: "3A" | "3B" | "3C";
  stage2Resume?: GlobalStage2Resume;
  allFiles?: FileEntry[];
  savedSessionId: string;
  savedFolderPath: string;
};

// Furthest completed artifact → resume label, in the exact priority order:
// strategic_assessment → Stage 4, interview → 3C, kronologi → 3B, analysis → 3A,
// extraction_progress → 2C, categorization → 2B, file_list → 2B (uncategorized)
export function resolveResumeLabel(data: GlobalResumeData): string {
  if (data.strategicAssessment) return "Stage 4 (Pembuatan Draf)";
  if (data.interviewAnswers?.length) return "Stage 3C (Asesmen Strategis)";
  if (data.kronologi) return "Stage 3B (Wawancara Klien)";
  if (data.analysis) return "Stage 3A (Kronologi)";
  if (data.stage2Resume?.type === "extraction_progress") return "Stage 2C (Ekstraksi)";
  if (data.stage2Resume?.type === "categorization") return "Stage 2B (Kategorisasi)";
  if (data.stage2Resume?.type === "file_list") return "Stage 2B (Kategorisasi)";
  return "Stage 1";
}

export function resolveResumeStage(data: GlobalResumeData): 1 | 2 | 3 | 4 {
  if (data.strategicAssessment) return 4;
  if (data.analysis || data.kronologi || data.interviewAnswers?.length) return 3;
  if (data.stage2Resume) return 2;
  return 1;
}

function buildStatusParts(data: GlobalResumeData): string[] {
  const parts: string[] = [];

  const s2 = data.stage2Resume;
  if (s2?.type === "extraction_progress") {
    const done = s2.processed ?? 0;
    const total = done + (s2.remainingFiles?.length ?? 0);
    parts.push("Kategorisasi: selesai");
    parts.push(`Ekstraksi: ${done} dari ${total} file selesai`);
  } else if (s2?.type === "categorization") {
    parts.push(`Kategorisasi: selesai (${s2.selectedFileIds?.length ?? "?"} file siap diekstrak)`);
  } else if (s2?.type === "file_list") {
    parts.push(`Daftar file: ${s2.files?.length ?? "?"} file ditemukan (belum dikategorikan)`);
  }

  if (data.analysis) {
    parts.push("Analisis: selesai");
    parts.push(data.kronologi ? "Kronologi: selesai" : "Kronologi: belum dimulai");
    if (data.kronologi) {
      parts.push(data.interviewAnswers?.length ? "Wawancara: selesai" : "Wawancara: belum dimulai");
    }
    if (data.interviewAnswers?.length) {
      parts.push(data.strategicAssessment ? "Asesmen: selesai" : "Asesmen: belum dimulai");
    }
  } else if (s2) {
    parts.push("Analisis: belum dimulai");
  }

  return parts;
}

export default function GlobalResumeBanner({
  data,
  onAccept,
  onDecline,
}: {
  data: GlobalResumeData;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const dateStr = data.latestTimestamp
    ? new Date(data.latestTimestamp).toLocaleString("id-ID", {
        day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "";
  const statusParts = buildStatusParts(data);
  const resumeLabel = resolveResumeLabel(data);

  return (
    <div style={{
      padding: "14px 18px",
      background: "rgba(91,155,213,0.08)",
      border: "1px solid rgba(91,155,213,0.35)",
      borderRadius: 4,
      marginBottom: 24,
    }}>
      <div style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6, marginBottom: 12 }}>
        ⟳ <strong>Sesi terakhir {dateStr}</strong>
        {statusParts.length > 0 && <> — {statusParts.join(". ")}.</>}{" "}
        Lanjutkan dari <strong>{resumeLabel}</strong>?
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onAccept}
          style={{ padding: "7px 16px", background: "var(--accent-blue)", color: "white", border: "none", borderRadius: 3, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
        >
          Ya, Lanjutkan
        </button>
        <button
          onClick={onDecline}
          style={{ padding: "7px 16px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 3, color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}
        >
          Tidak, Mulai Baru
        </button>
      </div>
    </div>
  );
}
