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
      body: JSON.stringify({ folderPath: last.folderPath }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.found) {
          setResumeData({
            ...data,
            savedSessionId: last.sessionId,
            savedFolderPath: last.folderPath,
          } as GlobalResumeData);
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleResume(data: GlobalResumeData) {
    dispatch({ type: "SET_SESSION_ID", id: data.savedSessionId });
    dispatch({ type: "SET_FOLDER", folderPath: data.savedFolderPath });
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
