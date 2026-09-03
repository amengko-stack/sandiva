"use client";

import { useState, useEffect, useRef } from "react";
import { useWorkflow, loadLastSession, clearLastSession } from "@/context/WorkflowContext";
import GlobalResumeBanner, { resolveResumeStage, type GlobalResumeData } from "@/components/GlobalResumeBanner";
import type { FileEntry } from "@/types";
import Stage1Select from "@/components/stages/Stage1Select";
import Stage2Files from "@/components/stages/Stage2Files";
import Stage3Analysis from "@/components/stages/Stage3Analysis";
import Stage4Draft from "@/components/stages/Stage4Draft";
import Stage5Output from "@/components/stages/Stage5Output";

export default function DrafterPage() {
  const { state, dispatch, goToStage } = useWorkflow();
  const [resumeData, setResumeData] = useState<GlobalResumeData | null>(null);
  const [resumeCheckFailed, setResumeCheckFailed] = useState(false);
  const hasChecked = useRef(false);

  useEffect(() => {
    if (hasChecked.current) return;
    hasChecked.current = true;
    // Active session in this tab (restored from sessionStorage) — no banner needed
    if (state.folderPath) return;

    const last = loadLastSession();
    if (!last) return;

    fetch("/api/sharepoint/check-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: last.sessionId, folderPath: last.folderPath }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`check-session ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data.found) {
          setResumeData({
            ...data,
            savedSessionId: last.sessionId,
            savedFolderPath: last.folderPath,
          } as GlobalResumeData);
        }
      })
      .catch((e) => {
        // The resume banner is the rescue path for lost sessions — failing to
        // check must not be invisible.
        console.warn("[drafter] check-session gagal:", e);
        setResumeCheckFailed(true);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleResume(data: GlobalResumeData) {
    dispatch({ type: "SET_SESSION_ID", id: data.savedSessionId });
    dispatch({ type: "SET_FOLDER", folderPath: data.savedFolderPath });
    // Restore the Stage-1 selection — Stage 4's draft request and the sidebar
    // are blind without docTypeId/claimType/pihak/ref.
    if (data.docTypeId) {
      dispatch({
        type: "SET_SELECTION",
        practiceAreaId: data.practiceAreaId ?? "",
        docTypeId: data.docTypeId,
        claimType: data.claimType ?? null,
        pihak: data.pihak ?? null,
      });
    } else if (data.pihak) {
      dispatch({ type: "SET_PIHAK", pihak: data.pihak });
    }
    if (data.ref) dispatch({ type: "SET_REF", ref: data.ref });
    if (data.partiesStrategy) dispatch({ type: "SET_PARTIES_STRATEGY", value: data.partiesStrategy });
    if (data.allFiles?.length) {
      dispatch({ type: "SET_ALL_FILES", files: data.allFiles });
    }
    if (data.stage2Resume?.type === "categorization" && data.stage2Resume.docMap) {
      const byId = new Map((data.allFiles ?? []).map((f) => [f.id, f]));
      const selected = (data.stage2Resume.selectedFileIds ?? [])
        .map((id) => byId.get(id))
        .filter((f): f is FileEntry => !!f);
      dispatch({ type: "SET_DOC_MAP", map: data.stage2Resume.docMap });
      if (selected.length) dispatch({ type: "SET_SELECTED_FILES", files: selected });
    }
    if (data.analysis) {
      const merged = data.kronologi ? { ...data.analysis, kronologi: data.kronologi } : data.analysis;
      dispatch({ type: "SET_CASE_ANALYSIS", analysis: merged });
    }
    // One-shot substep hint consumed by Stage3Analysis on mount
    if (data.resumeAtSubstep) {
      try { sessionStorage.setItem("sln_resume_substep_3", data.resumeAtSubstep); } catch {}
    }
    if (data.interviewAnswers?.length) dispatch({ type: "SET_INTERVIEW_ANSWERS", answers: data.interviewAnswers });
    if (data.strategicAssessment) dispatch({ type: "SET_STRATEGIC_ASSESSMENT", text: data.strategicAssessment });
    goToStage(resolveResumeStage(data));
    setResumeData(null);
  }

  function handleDecline() {
    if (resumeData) clearLastSession(resumeData.savedFolderPath);
    setResumeData(null);
  }

  const stages = {
    1: <Stage1Select />,
    2: <Stage2Files />,
    3: <Stage3Analysis />,
    4: <Stage4Draft />,
    5: <Stage5Output />,
  };

  return (
    <div
      style={{
        maxWidth: 900,
        margin: "0 auto",
        padding: "36px 40px",
      }}
    >
      {resumeCheckFailed && !resumeData && (
        <div style={{
          padding: "10px 16px",
          border: "1px solid var(--border-color)",
          borderRadius: 4,
          marginBottom: 16,
          fontSize: 13,
          color: "var(--text-muted)",
        }}>
          Sesi sebelumnya tidak dapat dipulihkan. Jika sesi telah berakhir atau belum terdaftar, mulai sesi baru dan pilih folder matter kembali.
        </div>
      )}
      {resumeData && (
        <GlobalResumeBanner
          data={resumeData}
          onAccept={() => handleResume(resumeData)}
          onDecline={handleDecline}
        />
      )}
      {stages[state.stage]}
    </div>
  );
}
