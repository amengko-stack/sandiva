"use client";

import { useState, useEffect, useRef } from "react";
import { useWorkflow } from "@/context/WorkflowContext";
import type { CaseAnalysis, InterviewAnswer, StructuredAssessment } from "@/types";

// Parse a stored assessment string: structured JSON from the new flow, or
// legacy free-text prose (rendered as a recommendation-only assessment).
function parseStoredAssessment(text: string): StructuredAssessment | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.kekuatan)) return parsed as StructuredAssessment;
  } catch {}
  return { kekuatan: [], kelemahan: [], risikoTersembunyi: [], rekomendasi: text };
}

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

  // 3B state — sub-step machine: pihak selection → loading → one-question
  // wizard → editable review
  type B3Step = "pihak" | "loading" | "wizard" | "review";
  const [b3Step, setB3Step] = useState<B3Step>("pihak");
  const [currentQ, setCurrentQ] = useState(0);
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [questionsError, setQuestionsError] = useState("");

  // 3C state — structured four-section assessment + risk-acknowledgment modal
  const [assessment, setAssessment] = useState<StructuredAssessment | null>(null);
  const [loadingAssessment, setLoadingAssessment] = useState(false);
  const [assessmentError, setAssessmentError] = useState("");
  const [riskModalOpen, setRiskModalOpen] = useState(false);
  const [riskChecks, setRiskChecks] = useState<boolean[]>([]);

  // Initial analysis
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");

  const hasFiredAnalysis = useRef(false);

  useEffect(() => {
    if (hasFiredAnalysis.current) return;
    hasFiredAnalysis.current = true;

    if (state.caseAnalysis) {
      setKronoText(state.caseAnalysis.kronologi || "");
      // One-shot substep hint from the global resume banner takes priority
      let hint: string | null = null;
      try {
        hint = sessionStorage.getItem("sln_resume_substep_3");
        if (hint) sessionStorage.removeItem("sln_resume_substep_3");
      } catch {}
      // Resume at the furthest completed substep:
      // interview answered → 3C, kronologi confirmed → 3B, analysis only → 3A
      if (state.strategicAssessment) {
        setAssessment(parseStoredAssessment(state.strategicAssessment));
        setSubstep("3C");
      } else if (state.interviewAnswers.length > 0 || hint === "3C") {
        setSubstep("3C");
        loadStrategicAssessment(state.interviewAnswers);
      } else if (hint === "3B") {
        enter3B();
      } else {
        setSubstep("3A");
      }
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
      // Read as text first: a platform error (timeout/crash) returns a plain-text
      // body that res.json() would obscure as "Unexpected token". Log it whole.
      const bodyText = await res.text();
      console.log(`[stage3] /api/analyze status=${res.status} bodyLen=${bodyText.length} body=${bodyText.slice(0, 2000)}`);
      let data: { analysis?: CaseAnalysis; error?: string };
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new Error(`Server mengembalikan respons non-JSON (status ${res.status}): ${bodyText.slice(0, 300)}`);
      }
      if (!res.ok || !data.analysis) throw new Error(data.error || "Gagal menganalisis perkara");
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

  // Enter 3B: pihak must be chosen before anything else renders. If it's
  // already known (resume, or a hasPihak docType chosen in Stage 1), skip
  // straight to question generation.
  function enter3B() {
    setSubstep("3B");
    if (state.pihak) {
      setB3Step("loading");
      loadInterviewQuestions(state.pihak);
    } else {
      setB3Step("pihak");
    }
  }

  function choosePihak(p: string) {
    dispatch({ type: "SET_PIHAK", pihak: p });
    setB3Step("loading");
    loadInterviewQuestions(p);
  }

  async function loadInterviewQuestions(pihakValue: string) {
    setQuestionsError("");
    try {
      const res = await fetch("/api/analyze/interview-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseAnalysis: state.caseAnalysis,
          docTypeId: state.docTypeId,
          claimType: state.claimType,
          pihak: pihakValue,
          kronologi: state.caseAnalysis?.kronologi ?? "",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menghasilkan pertanyaan");
      setQuestions(data.questions);
      setAnswers(data.questions.map(() => ""));
      setCurrentQ(0);
      setB3Step("wizard");
    } catch (e: unknown) {
      setQuestionsError(e instanceof Error ? e.message : "Terjadi kesalahan");
    }
  }

  async function loadStrategicAssessment(ia: InterviewAnswer[]) {
    setLoadingAssessment(true);
    setAssessmentError("");
    try {
      const res = await fetch("/api/analyze/strategic-assessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          docTypeId: state.docTypeId,
          claimType: state.claimType,
          pihak: state.pihak,
          kronologi: state.caseAnalysis?.kronologi ?? "",
          interviewAnswers: ia,
          caseAnalysis: state.caseAnalysis,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gagal menghasilkan asesmen");
      setAssessment(data.assessment as StructuredAssessment);
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
    enter3B();
  }

  function confirm3B() {
    const ia: InterviewAnswer[] = questions.map((q, i) => ({ question: q, answer: answers[i] || "" }));
    dispatch({ type: "SET_INTERVIEW_ANSWERS", answers: ia });
    // Durable saves: Vercel Blob (session) + SharePoint (matter audit trail)
    fireAndForget("/api/analyze/save-interview", {
      sessionId: state.sessionId,
      answers: ia,
      pihak: state.pihak,
    });
    if (state.folderPath) {
      fireAndForget("/api/sharepoint/save-matter-file", {
        folderPath: state.folderPath,
        filename: `AI/interview_${ts()}.json`,
        content: JSON.stringify({ ref: state.ref, pihak: state.pihak, answers: ia, timestamp: new Date().toISOString() }),
      });
    }
    setSubstep("3C");
    loadStrategicAssessment(ia);
  }

  // "Lanjut dengan Strategi Ini": real risks require explicit per-risk
  // acknowledgment in a modal before proceeding.
  function proceedWithStrategy() {
    if (!assessment) return;
    if (assessment.risikoTersembunyi.length > 0) {
      setRiskChecks(assessment.risikoTersembunyi.map(() => false));
      setRiskModalOpen(true);
    } else {
      confirm3C();
    }
  }

  function confirm3C() {
    if (!assessment) return;
    const assessmentJson = JSON.stringify(assessment);
    dispatch({ type: "SET_STRATEGIC_ASSESSMENT", text: assessmentJson });
    fireAndForget("/api/analyze/save-assessment", {
      sessionId: state.sessionId,
      assessment,
    });
    if (state.folderPath) {
      fireAndForget("/api/sharepoint/save-matter-file", {
        folderPath: state.folderPath,
        // assessment stored as JSON string so check-session resume (which
        // expects a string) keeps working; parseStoredAssessment re-hydrates.
        filename: `AI/strategic_assessment_${ts()}.json`,
        content: JSON.stringify({ ref: state.ref, assessment: assessmentJson, timestamp: new Date().toISOString() }),
      });
    }
    setRiskModalOpen(false);
    goToStage(4);
  }

  // "Ubah Pendekatan": back to Stage 1 WITHOUT reset — sessionId, folderPath,
  // and all extracted-session state persist, so nothing is re-extracted.
  function ubahPendekatan() {
    try { sessionStorage.setItem("sln_change_approach", "1"); } catch {}
    goToStage(1);
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

  // ── 3B — Interview Strategis ─────────────────────────────────────────────────
  if (substep === "3B") {
    return (
      <div>
        <StepHeader step="3B" title="Interview Strategis" total={3} />

        {/* Sub-step 1: pihak selection — nothing else renders until chosen */}
        {b3Step === "pihak" && (
          <div>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 24 }}>
              Pihak mana yang kita wakili dalam perkara ini? Pertanyaan wawancara akan disusun spesifik untuk posisi pihak tersebut.
            </p>
            <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
              {[
                { value: "penggugat", label: "Penggugat / Pemohon", desc: "Kami mengajukan gugatan/permohonan" },
                { value: "tergugat", label: "Tergugat / Termohon", desc: "Kami membela terhadap gugatan/permohonan" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => choosePihak(opt.value)}
                  style={{
                    flex: 1, padding: "28px 24px", background: "var(--bg-surface)",
                    border: "2px solid var(--border-color)", borderRadius: 8,
                    cursor: "pointer", textAlign: "left",
                  }}
                >
                  <div style={{ fontSize: 17, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
                    {opt.label}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{opt.desc}</div>
                </button>
              ))}
            </div>
            <button onClick={() => setSubstep("3A")} style={btnSecondary}>← Kembali</button>
          </div>
        )}

        {/* Sub-step 2: generating questions */}
        {b3Step === "loading" && (
          <div>
            {!questionsError ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 20, background: "var(--bg-surface)", borderRadius: 4, border: "1px solid var(--border-color)" }}>
                <Spinner /><span style={{ color: "var(--text-muted)", fontSize: 14 }}>Menyusun pertanyaan strategis untuk posisi {state.pihak === "tergugat" ? "Tergugat / Termohon" : "Penggugat / Pemohon"}...</span>
              </div>
            ) : (
              <div style={{ padding: 14, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13 }}>
                {questionsError}
                <button onClick={() => { setQuestionsError(""); loadInterviewQuestions(state.pihak || "penggugat"); }} style={{ marginLeft: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>Coba lagi</button>
              </div>
            )}
          </div>
        )}

        {/* Sub-step 3: one question at a time */}
        {b3Step === "wizard" && questions.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-gold)", letterSpacing: "0.08em", marginBottom: 14 }}>
              PERTANYAAN {currentQ + 1} DARI {questions.length}
            </div>
            <div style={{ padding: "18px 20px", background: "var(--bg-surface)", border: "1px solid var(--border-color)", borderRadius: 6, marginBottom: 14 }}>
              <div style={{ fontSize: 15, color: "var(--text-primary)", lineHeight: 1.6 }}>{questions[currentQ]}</div>
            </div>
            <textarea
              value={answers[currentQ] || ""}
              onChange={(e) => {
                const next = [...answers];
                next[currentQ] = e.target.value;
                setAnswers(next);
              }}
              rows={5}
              placeholder="Jawaban berdasarkan keterangan klien..."
              autoFocus
              style={{ resize: "vertical", fontSize: 13, lineHeight: 1.6, width: "100%" }}
            />
            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button
                onClick={() => setCurrentQ((i) => Math.max(0, i - 1))}
                disabled={currentQ === 0}
                style={{ ...btnSecondary, opacity: currentQ === 0 ? 0.4 : 1, cursor: currentQ === 0 ? "default" : "pointer" }}
              >
                ← Kembali
              </button>
              <button
                onClick={() => {
                  if (currentQ < questions.length - 1) setCurrentQ(currentQ + 1);
                  else setB3Step("review");
                }}
                style={btnPrimary}
              >
                {currentQ < questions.length - 1 ? "Lanjut →" : "Tinjau Jawaban →"}
              </button>
            </div>
          </div>
        )}

        {/* Sub-step 4: editable review + single confirm */}
        {b3Step === "review" && (
          <div>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 20 }}>
              Tinjau seluruh jawaban. Anda dapat menyunting langsung sebelum konfirmasi.
            </p>
            {questions.map((q, i) => (
              <div key={i} style={{ marginBottom: 18 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--accent-gold)", letterSpacing: "0.06em", marginBottom: 6 }}>
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
                  placeholder="(tidak dijawab)"
                  style={{ resize: "vertical", fontSize: 13, lineHeight: 1.6, width: "100%" }}
                />
              </div>
            ))}
            <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
              <button onClick={() => setB3Step("wizard")} style={btnSecondary}>← Kembali ke Pertanyaan</button>
              <button onClick={confirm3B} style={btnPrimary}>Konfirmasi Jawaban →</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── 3C — Penilaian Strategis (four-section structured assessment) ───────────
  const allRisksAcked = riskChecks.length > 0 && riskChecks.every(Boolean);
  return (
    <div>
      <StepHeader step="3C" title="Penilaian Strategis" total={3} />
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 20 }}>
        Penilaian posisi perkara sebelum penyusunan draf — termasuk pemeriksaan risiko yurisdiksi dan prosedural.
      </p>
      {loadingAssessment && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 20, background: "var(--bg-surface)", borderRadius: 4, border: "1px solid var(--border-color)", marginBottom: 20 }}>
          <Spinner /><span style={{ color: "var(--text-muted)", fontSize: 14 }}>Menilai posisi perkara dan memeriksa risiko tersembunyi...</span>
        </div>
      )}
      {assessmentError && (
        <div style={{ padding: 14, background: "rgba(192,57,43,0.1)", border: "1px solid var(--error)", borderRadius: 4, color: "var(--error)", fontSize: 13, marginBottom: 20 }}>
          {assessmentError}
          <button onClick={() => loadStrategicAssessment(state.interviewAnswers)} style={{ marginLeft: 12, color: "var(--accent-blue)", background: "none", border: "none", cursor: "pointer", fontSize: 13 }}>Coba lagi</button>
        </div>
      )}

      {!loadingAssessment && assessment && (
        <div>
          <AssessmentSection title="KEKUATAN" color="#27ae60" items={assessment.kekuatan} emptyText="Tidak ada kekuatan yang teridentifikasi" />
          <AssessmentSection title="KELEMAHAN" color="#f1c40f" items={assessment.kelemahan} emptyText="Tidak ada kelemahan yang teridentifikasi" />
          <AssessmentSection
            title="RISIKO TERSEMBUNYI"
            color="#c0392b"
            prominent
            items={assessment.risikoTersembunyi}
            emptyText="Tidak ditemukan risiko tersembunyi"
          />
          <div style={{ borderLeft: "4px solid var(--accent-blue)", background: "var(--bg-surface)", borderRadius: 4, padding: "16px 20px", marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: "var(--accent-blue)", marginBottom: 10 }}>REKOMENDASI</div>
            <div style={{ fontSize: 14, color: "var(--text-primary)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{assessment.rekomendasi}</div>
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={proceedWithStrategy} style={btnPrimary}>Lanjut dengan Strategi Ini →</button>
            <button onClick={ubahPendekatan} style={btnSecondary}>Ubah Pendekatan</button>
          </div>
        </div>
      )}

      {/* Risk acknowledgment modal — every risk must be ticked to proceed */}
      {riskModalOpen && assessment && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: 8, padding: "28px 32px", maxWidth: 640, width: "92%", maxHeight: "80vh", overflowY: "auto" }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, color: "#c0392b", marginBottom: 8 }}>
              Konfirmasi Risiko Tersembunyi
            </h2>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 18 }}>
              Centang setiap risiko untuk menyatakan Anda telah membacanya dan tetap ingin melanjutkan dengan strategi ini.
            </p>
            {assessment.risikoTersembunyi.map((risk, i) => (
              <label key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 14px", background: "rgba(192,57,43,0.06)", border: "1px solid rgba(192,57,43,0.3)", borderRadius: 4, marginBottom: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={riskChecks[i] || false}
                  onChange={() => setRiskChecks((rc) => rc.map((v, j) => (j === i ? !v : v)))}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span style={{ fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6 }}>{risk}</span>
              </label>
            ))}
            <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
              <button onClick={() => setRiskModalOpen(false)} style={btnSecondary}>Batal</button>
              <button
                onClick={confirm3C}
                disabled={!allRisksAcked}
                style={{ ...btnPrimary, opacity: allRisksAcked ? 1 : 0.4, cursor: allRisksAcked ? "pointer" : "not-allowed" }}
              >
                Konfirmasi & Lanjut ke Draf →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AssessmentSection({
  title, color, items, emptyText, prominent,
}: {
  title: string; color: string; items: string[]; emptyText: string; prominent?: boolean;
}) {
  const isEmpty = items.length === 0;
  return (
    <div style={{
      borderLeft: `4px solid ${color}`,
      background: prominent && !isEmpty ? "rgba(192,57,43,0.06)" : "var(--bg-surface)",
      borderRadius: 4,
      padding: "16px 20px",
      marginBottom: 16,
    }}>
      <div style={{ fontSize: prominent ? 13 : 12, fontWeight: 700, letterSpacing: "0.08em", color, marginBottom: 10 }}>
        {title}
      </div>
      {isEmpty ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>{emptyText}</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {items.map((item, i) => (
            <li key={i} style={{ fontSize: 13.5, color: "var(--text-primary)", lineHeight: 1.7, marginBottom: 8 }}>{item}</li>
          ))}
        </ul>
      )}
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
