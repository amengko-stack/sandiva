"use client";

import { useState, useEffect, useRef } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { CaseAnalysis, InterviewAnswer } from "@/types";

type Stage3Substep = "3A" | "3B" | "3C";

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function fireAndForget(url: string, body: object) {
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export default function Stage3Analysis() {
  const { state, dispatch, goToStage } = useWorkflow();
  const [substep, setSubstep] = useState<Stage3Substep | null>(null);

  // 3A state
  const [kronoText, setKronoText] = useState("");

  // 3B state
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [questionsError, setQuestionsError] = useState("");

  // 3C state
  const [assessmentText, setAssessmentText] = useState("");
  const [loadingAssessment, setLoadingAssessment] = useState(false);
  const [assessmentError, setAssessmentError] = useState("");

  // Initial analysis
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");

  const hasFiredAnalysis = useRef(false);

  useEffect(() => {
    if (hasFiredAnalysis.current) return;
    hasFiredAnalysis.current = true;

    if (state.caseAnalysis) {
      setKronoText(state.caseAnalysis.kronologi || "");
      setSubstep("3A");
    } else {
      runAnalysis();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAnalysis() {
    setAnalyzing(true);
    setAnalyzeError("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          docTypeId: state.docTypeId,
          practiceAreaId: state.practiceAreaId,
          claimType: state.claimType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menganalisis perkara");
      dispatch({ type: "SET_CASE_ANALYSIS", analysis: data.analysis });
      setKronoText(data.analysis.kronologi || "");

      // Fire-and-forget save analysis to SharePoint
      if (state.folderPath) {
        fireAndForget("/api/sharepoint/save-matter-file", {
          folderPath: state.folderPath,
          filename: `AI/analysis_${ts()}.json`,
          content: JSON.stringify({ ref: state.ref, analysis: data.analysis, timestamp: new Date().toISOString() }),
        });
      }

      setSubstep("3A");
    } catch (e: unknown) {
      setAnalyzeError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setAnalyzing(false);
    }
  }

  async function loadInterviewQuestions() {
    setLoadingQuestions(true);
    setQuestionsError("");
    try {
      const res = await fetch("/api/analyze/interview-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseAnalysis: state.caseAnalysis }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menghasilkan pertanyaan");
      setQuestions(data.questions);
      setAnswers(data.questions.map(() => ""));
    } catch (e: unknown) {
      setQuestionsError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setLoadingQuestions(false);
    }
  }

  async function loadStrategicAssessment(ia: InterviewAnswer[]) {
    setLoadingAssessment(true);
    setAssessmentError("");
    try {
      const res = await fetch("/api/analyze/strategic-assessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseAnalysis: state.caseAnalysis, interviewAnswers: ia }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menghasilkan asesmen");
      setAssessmentText(data.assessment);
    } catch (e: unknown) {
      setAssessmentError(e instanceof Error ? e.message : "Terjadi kesalahan");
    } finally {
      setLoadingAssessment(false);
    }
  }

  function confirm3A() {
    const updated: CaseAnalysis = { ...state.caseAnalysis!, kronologi: kronoText };
    dispatch({ type: "SET_CASE_ANALYSIS", analysis: updated });
    if (state.folderPath) {
      fireAndForget("/api/sharepoint/save-matter-file", {
        folderPath: state.folderPath,
        filename: `AI/kronologi_${ts()}.json`,
        content: JSON.stringify({ ref: state.ref, kronologi: kronoText, timestamp: new Date().toISOString() }),
      });
    }
    setSubstep("3B");
    loadInterviewQuestions();
  }

  function confirm3B() {
    const ia: InterviewAnswer[] = questions.map((q, i) => ({ question: q, answer: answers[i] || "" }));
    dispatch({ type: "SET_INTERVIEW_ANSWERS", answers: ia });
    if (state.folderPath) {
      fireAndForget("/api/sharepoint/save-matter-file", {
        folderPath: state.folderPath,
        filename: `AI/interview_${ts()}.json`,
        content: JSON.stringify({ ref: state.ref, answers: ia, timestamp: new Date().toISOString() }),
      });
    }
    setSubstep("3C");
    loadStrategicAssessment(ia);
  }

  function confirm3C() {
    dispatch({ type: "SET_STRATEGIC_ASSESSMENT", text: assessmentText });
    if (state.folderPath) {
      fireAndForget("/api/sharepoint/save-matter-file", {
        folderPath: state.folderPath,
        filename: `AI/strategic_assessment_${ts()}.json`,
        content: JSON.stringify({ ref: state.ref, assessment: assessmentText, timestamp: new Date().toISOString() }),
      });
    }
    goToStage(4);
  }

  // ── Loading / error for initial analysis ────────────────────────────────────
  if (substep === null) {
    return (
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>
          Analisis Perkara
        </h1>
        {analyzing && (
          <div style={{ padding: 24, background: "var(--bg-surface)", borderRadius: 4, border: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: 16 }}>
            <Spinner />
            <span style={{ color: "var(--text-muted)", fontSize: 14 }}>Memulai Analisis...</span>
          </div>
        )}
        {analyzeError && (
          <div style={{ padding: 16, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13 }}>
            {analyzeError}
            <button onClick={runAnalysis} style={{ marginLeft: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>
              Coba lagi
            </button>
          </div>
        )}
        <button onClick={() => goToStage(2)} style={{ marginTop: 20, padding: "10px 20px", background: "transparent", border: "1px solid var(--border-color)", borderRadius: 4, color: "var(--text-muted)", fontSize: 14, cursor: "pointer" }}>
          ← Kembali
        </button>
      </div>
    );
  }

  // ── 3A — Kronologi ───────────────────────────────────────────────────────────
  if (substep === "3A") {
    return (
      <div>
        <StepHeader step="3A" title="Kronologi Fakta Material" total={3} />
        <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 20 }}>
          Tinjau dan koreksi kronologi yang dihasilkan AI sebelum melanjutkan.
        </p>
        <textarea
          value={kronoText}
          onChange={(e) => setKronoText(e.target.value)}
          rows={14}
          style={{ resize: "vertical", fontSize: 13, lineHeight: 1.7, width: "100%" }}
        />
        <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
          <button onClick={() => goToStage(2)} style={btnSecondary}>← Kembali</button>
          <button onClick={confirm3A} style={btnPrimary}>Konfirmasi Kronologi →</button>
        </div>
      </div>
    );
  }

  // ── 3B — Interview ───────────────────────────────────────────────────────────
  if (substep === "3B") {
    return (
      <div>
        <StepHeader step="3B" title="Pertanyaan Wawancara Klien" total={3} />
        <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 20 }}>
          Jawab pertanyaan berikut berdasarkan hasil wawancara dengan klien.
        </p>
        {loadingQuestions && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 20, background: "var(--bg-surface)", borderRadius: 4, border: "1px solid var(--border-color)", marginBottom: 20 }}>
            <Spinner /><span style={{ color: "var(--text-muted)", fontSize: 14 }}>Menghasilkan pertanyaan...</span>
          </div>
        )}
        {questionsError && (
          <div style={{ padding: 14, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 20 }}>
            {questionsError}
            <button onClick={loadInterviewQuestions} style={{ marginLeft: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>Coba lagi</button>
          </div>
        )}
        {questions.length > 0 && (
          <div>
            {questions.map((q, i) => (
              <div key={i} style={{ marginBottom: 20 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--accent-gold)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
                  {i + 1}. {q}
                </label>
                <textarea
                  value={answers[i] || ""}
                  onChange={(e) => {
                    const next = [...answers];
                    next[i] = e.target.value;
                    setAnswers(next);
                  }}
                  rows={3}
                  placeholder="Jawaban..."
                  style={{ resize: "vertical", fontSize: 13, lineHeight: 1.6, width: "100%" }}
                />
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
          <button onClick={() => setSubstep("3A")} style={btnSecondary}>← Kembali</button>
          {questions.length > 0 && !loadingQuestions && (
            <button onClick={confirm3B} style={btnPrimary}>Konfirmasi Jawaban →</button>
          )}
        </div>
      </div>
    );
  }

  // ── 3C — Strategic Assessment ────────────────────────────────────────────────
  return (
    <div>
      <StepHeader step="3C" title="Asesmen Strategis" total={3} />
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 20 }}>
        Tinjau dan koreksi asesmen strategis yang dihasilkan AI.
      </p>
      {loadingAssessment && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 20, background: "var(--bg-surface)", borderRadius: 4, border: "1px solid var(--border-color)", marginBottom: 20 }}>
          <Spinner /><span style={{ color: "var(--text-muted)", fontSize: 14 }}>Menghasilkan asesmen strategis...</span>
        </div>
      )}
      {assessmentError && (
        <div style={{ padding: 14, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 20 }}>
          {assessmentError}
          <button onClick={() => loadStrategicAssessment(state.interviewAnswers)} style={{ marginLeft: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>Coba lagi</button>
        </div>
      )}
      {!loadingAssessment && assessmentText && (
        <textarea
          value={assessmentText}
          onChange={(e) => setAssessmentText(e.target.value)}
          rows={14}
          style={{ resize: "vertical", fontSize: 13, lineHeight: 1.7, width: "100%" }}
        />
      )}
      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        <button onClick={() => setSubstep("3B")} style={btnSecondary}>← Kembali</button>
        {assessmentText && !loadingAssessment && (
          <button onClick={confirm3C} style={btnPrimary}>Konfirmasi Asesmen →</button>
        )}
      </div>
    </div>
  );
}

function StepHeader({ step, title, total }: { step: string; title: string; total: number }) {
  const steps = ["3A", "3B", "3C"].slice(0, total);
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {steps.map((s) => (
          <div key={s} style={{
            padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600,
            background: s === step ? "var(--accent-blue)" : "var(--bg-surface)",
            color: s === step ? "white" : "var(--text-muted)",
            border: "1px solid " + (s === step ? "var(--accent-blue)" : "var(--border-color)"),
          }}>
            {s}
          </div>
        ))}
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>{title}</h1>
    </div>
  );
}

function Spinner() {
  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid var(--border-color)", borderTopColor: "var(--accent-blue)", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
    </>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: "10px 24px", background: "var(--accent-blue)", color: "white",
  border: "none", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "10px 20px", background: "transparent", border: "1px solid var(--border-color)",
  borderRadius: 4, color: "var(--text-muted)", fontSize: 14, cursor: "pointer",
};
