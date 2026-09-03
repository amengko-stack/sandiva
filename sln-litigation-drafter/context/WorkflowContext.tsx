"use client";

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { WorkflowState, WorkflowAction, Stage } from "@/types";

const SESSION_KEY = "sln_workflow_state";
const LAST_MATTER_KEY = "sln_last_matter";
const MATTER_PREFIX = "sln_matter_";

export interface LastSessionRecord {
  sessionId: string;
  folderPath: string;
  timestamp: string;
}

// localStorage entries are keyed by matterFolderPath so two matters open in
// two tabs never collide; LAST_MATTER_KEY points at the most recent one.
function matterKey(folderPath: string): string {
  return MATTER_PREFIX + encodeURIComponent(folderPath);
}

export function loadLastSession(): LastSessionRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const lastFolder = localStorage.getItem(LAST_MATTER_KEY);
    if (!lastFolder) return null;
    const raw = localStorage.getItem(matterKey(lastFolder));
    if (!raw) return null;
    return JSON.parse(raw) as LastSessionRecord;
  } catch {
    return null;
  }
}

export function clearLastSession(folderPath?: string) {
  if (typeof window === "undefined") return;
  try {
    const target = folderPath ?? localStorage.getItem(LAST_MATTER_KEY);
    if (target) localStorage.removeItem(matterKey(target));
    if (!folderPath || localStorage.getItem(LAST_MATTER_KEY) === folderPath) {
      localStorage.removeItem(LAST_MATTER_KEY);
    }
  } catch {}
}

const initialState: WorkflowState = {
  stage: 1,
  sessionId: "",
  practiceAreaId: null,
  docTypeId: null,
  claimType: null,
  pihak: null,
  folderPath: "",
  allFiles: [],
  docMap: [],
  selectedFiles: [],
  caseAnalysis: null,
  reviewTable: [],
  chronology: null,
  interviewAnswers: [],
  strategicAssessment: "",
  userCorrections: "",
  draftText: "",
  isDraftStreaming: false,
  draftComplete: false,
  critiqueItems: [],
  isCritiqueLoading: false,
  factCheck: [],
  draftVersions: [],
  draftVersion: 0,
  ref: "",
  savedToSharePoint: false,
  approvedForMemory: false,
  selectedJurisprudence: [],
  partiesStrategy: null,
  addedFileIds: [],
  error: null,
};

function reducer(state: WorkflowState, action: WorkflowAction): WorkflowState {
  switch (action.type) {
    case "SET_STAGE":
      return { ...state, stage: action.stage, error: null };

    case "SET_SELECTION":
      return {
        ...state,
        practiceAreaId: action.practiceAreaId,
        docTypeId: action.docTypeId,
        claimType: action.claimType,
        pihak: action.pihak,
      };

    case "SET_FOLDER":
      return { ...state, folderPath: action.folderPath };

    case "SET_PIHAK":
      return { ...state, pihak: action.pihak };

    case "SET_SESSION_ID":
      return { ...state, sessionId: action.id };

    case "SET_ALL_FILES":
      return { ...state, allFiles: action.files };

    case "SET_DOC_MAP":
      return { ...state, docMap: action.map };

    case "TOGGLE_FILE":
      return {
        ...state,
        allFiles: state.allFiles.map((f) =>
          f.id === action.id ? { ...f, selected: !f.selected } : f
        ),
      };

    case "UPDATE_DOC_MAP_ENTRY":
      return {
        ...state,
        docMap: state.docMap.map((e) =>
          e.fileId === action.fileId ? { ...e, ...action.patch } : e
        ),
      };

    case "SET_SELECTED_FILES":
      return { ...state, selectedFiles: action.files };

    case "SET_CASE_ANALYSIS":
      return { ...state, caseAnalysis: action.analysis };

    case "SET_REVIEW_TABLE":
      return { ...state, reviewTable: action.rows };

    case "SET_CHRONOLOGY":
      return { ...state, chronology: action.data };

    case "SET_INTERVIEW_ANSWERS":
      return { ...state, interviewAnswers: action.answers };

    case "SET_STRATEGIC_ASSESSMENT":
      return { ...state, strategicAssessment: action.text };

    case "SET_USER_CORRECTIONS":
      return { ...state, userCorrections: action.text };

    case "APPEND_DRAFT":
      return { ...state, draftText: state.draftText + action.chunk };

    case "RESET_DRAFT":
      // Clears the working draft for a revision/regeneration. Version history
      // is intentionally KEPT — it feeds "Riwayat Revisi" and the
      // MAX_REVISIONS cost cap; use RESET_ALL_DRAFTS to wipe it.
      // factCheck belongs to the cleared draft text, so it goes too.
      return { ...state, draftText: "", draftComplete: false, critiqueItems: [], factCheck: [] };

    case "RESET_ALL_DRAFTS":
      return { ...state, draftText: "", draftComplete: false, critiqueItems: [], factCheck: [], draftVersions: [], draftVersion: 0 };

    case "SET_DRAFT_STREAMING":
      return { ...state, isDraftStreaming: action.value };

    case "SET_DRAFT_COMPLETE":
      return { ...state, draftComplete: action.value };

    case "SET_CRITIQUE":
      return { ...state, critiqueItems: action.items };

    case "SET_CRITIQUE_LOADING":
      return { ...state, isCritiqueLoading: action.value };

    case "SET_FACT_CHECK":
      return { ...state, factCheck: action.items };

    case "ADD_DRAFT_VERSION":
      return { ...state, draftVersions: [...state.draftVersions, action.version] };

    case "SET_DRAFT_VERSION":
      return { ...state, draftVersion: action.version };

    case "SET_REF":
      return { ...state, ref: action.ref };

    case "SET_SAVED_SHAREPOINT":
      return { ...state, savedToSharePoint: action.value };

    case "SET_APPROVED_MEMORY":
      return { ...state, approvedForMemory: action.value };

    case "SET_SELECTED_JURISPRUDENCE":
      return { ...state, selectedJurisprudence: action.entries };

    case "SET_PARTIES_STRATEGY":
      return { ...state, partiesStrategy: action.value };

    case "MARK_FILES_ADDED":
      return { ...state, addedFileIds: Array.from(new Set([...state.addedFileIds, ...action.ids])) };

    case "CLEAR_ANALYSIS":
      // Force Stage 3A re-analysis with the full document set while preserving
      // the drafter's interview answers and party identities/strategy. The
      // review table and chronology are document-derived, so they must
      // regenerate too.
      return { ...state, caseAnalysis: null, strategicAssessment: "", reviewTable: [], chronology: null };

    case "SET_ERROR":
      return { ...state, error: action.error };

    case "HYDRATE":
      // In-flight streams never survive a reload: restoring isDraftStreaming
      // as true would freeze Stage 4 on a spinner no code path can clear.
      // Fields added after a deploy may be missing from older snapshots —
      // default them so components never see undefined.
      return {
        ...action.state,
        reviewTable: action.state.reviewTable ?? [],
        chronology: action.state.chronology ?? null,
        factCheck: action.state.factCheck ?? [],
        isDraftStreaming: false,
        isCritiqueLoading: false,
      };

    case "RESET":
      return { ...initialState, sessionId: "", selectedJurisprudence: [], partiesStrategy: null, addedFileIds: [] };

    default:
      return state;
  }
}

interface WorkflowContextValue {
  state: WorkflowState;
  dispatch: React.Dispatch<WorkflowAction>;
  goToStage: (stage: Stage) => void;
}

const WorkflowContext = createContext<WorkflowContextValue | null>(null);

export function WorkflowProvider({ children }: { children: ReactNode }) {
  // Initialize deterministically so the server render and the client's first
  // (hydration) render produce identical output. Persisted state is loaded from
  // sessionStorage AFTER mount via HYDRATE — reading it during render would make
  // the client tree diverge from the server HTML (React #418/#423 hydration error).
  const [state, dispatch] = useReducer(reducer, initialState);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const saved = sessionStorage.getItem(SESSION_KEY);
        if (!saved) return;
        const candidate = JSON.parse(saved) as WorkflowState;
        if (candidate.sessionId || candidate.folderPath) {
          const response = await fetch("/api/session/validate", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: candidate.sessionId, folderPath: candidate.folderPath }),
          });
          if (!response.ok) throw new Error("Sesi tidak terdaftar atau telah berakhir. Mulai sesi baru dan pilih folder matter kembali.");
          const registered = await response.json();
          candidate.sessionId = registered.sessionId;
          candidate.folderPath = registered.folderPath;
        }
        if (!cancelled) dispatch({ type: "HYDRATE", state: candidate });
      } catch (e) {
        if (!cancelled) dispatch({ type: "SET_ERROR", error: e instanceof Error ? e.message : "Sesi tidak dapat dipulihkan." });
      } finally {
        if (!cancelled) setHydrated(true);
      }
    }
    void restore();
    return () => { cancelled = true; };
  }, []);

  // Persistence is throttled: during draft streaming the state changes once
  // per SSE chunk, and serializing the full workflow state (files + analysis
  // + draft text) on every chunk janks the UI. Latest state lives in a ref;
  // writes happen at most every 800ms plus a flush on pagehide.
  const stateRef = useRef(state);
  stateRef.current = state;
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnedQuota = useRef(false);
  const flushPersist = useRef(() => {});
  flushPersist.current = () => {
    if (persistTimer.current !== null) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    const s = stateRef.current;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch (e) {
      // A silently-failed write means refresh loses progress — say so once.
      if (!warnedQuota.current) {
        warnedQuota.current = true;
        console.warn(
          "[workflow] Gagal menyimpan state sesi ke sessionStorage (kemungkinan kuota penuh) — refresh dapat kehilangan progres.",
          e
        );
      }
    }
    // Persist sessionId + folderPath to localStorage (survives browser close)
    if (s.folderPath && s.sessionId) {
      try {
        const record: LastSessionRecord = {
          sessionId: s.sessionId,
          folderPath: s.folderPath,
          timestamp: new Date().toISOString(),
        };
        localStorage.setItem(matterKey(s.folderPath), JSON.stringify(record));
        localStorage.setItem(LAST_MATTER_KEY, s.folderPath);
      } catch {}
    }
  };

  useEffect(() => {
    // Don't persist until the saved session has been loaded, otherwise the
    // initial `initialState` would clobber the stored session before HYDRATE runs.
    if (!hydrated) return;
    if (persistTimer.current !== null) return; // a write is already scheduled
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      flushPersist.current();
    }, 800);
  }, [state, hydrated]);

  useEffect(() => {
    const onPageHide = () => flushPersist.current();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  function goToStage(stage: Stage) {
    dispatch({ type: "SET_STAGE", stage });
  }

  return (
    <WorkflowContext.Provider value={{ state, dispatch, goToStage }}>
      {hydrated ? children : (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>
          Memuat…
        </div>
      )}
    </WorkflowContext.Provider>
  );
}

export function useWorkflow() {
  const ctx = useContext(WorkflowContext);
  if (!ctx) throw new Error("useWorkflow must be used within WorkflowProvider");
  return ctx;
}
