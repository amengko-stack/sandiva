"use client";

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
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

function newSessionId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const initialState: WorkflowState = {
  stage: 1,
  sessionId: newSessionId(),
  practiceAreaId: null,
  docTypeId: null,
  claimType: null,
  pihak: null,
  folderPath: "",
  allFiles: [],
  docMap: [],
  selectedFiles: [],
  caseAnalysis: null,
  interviewAnswers: [],
  strategicAssessment: "",
  userCorrections: "",
  draftText: "",
  isDraftStreaming: false,
  draftComplete: false,
  critiqueText: "",
  isCritiqueLoading: false,
  ref: "",
  savedToSharePoint: false,
  approvedForMemory: false,
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

    case "SET_INTERVIEW_ANSWERS":
      return { ...state, interviewAnswers: action.answers };

    case "SET_STRATEGIC_ASSESSMENT":
      return { ...state, strategicAssessment: action.text };

    case "SET_USER_CORRECTIONS":
      return { ...state, userCorrections: action.text };

    case "APPEND_DRAFT":
      return { ...state, draftText: state.draftText + action.chunk };

    case "RESET_DRAFT":
      return { ...state, draftText: "", draftComplete: false, critiqueText: "" };

    case "SET_DRAFT_STREAMING":
      return { ...state, isDraftStreaming: action.value };

    case "SET_DRAFT_COMPLETE":
      return { ...state, draftComplete: action.value };

    case "SET_CRITIQUE":
      return { ...state, critiqueText: action.text };

    case "SET_CRITIQUE_LOADING":
      return { ...state, isCritiqueLoading: action.value };

    case "SET_REF":
      return { ...state, ref: action.ref };

    case "SET_SAVED_SHAREPOINT":
      return { ...state, savedToSharePoint: action.value };

    case "SET_APPROVED_MEMORY":
      return { ...state, approvedForMemory: action.value };

    case "SET_ERROR":
      return { ...state, error: action.error };

    case "RESET":
      return { ...initialState, sessionId: newSessionId() };

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
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    if (typeof window === "undefined") return init;
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) return JSON.parse(saved) as WorkflowState;
    } catch {}
    return init;
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch {}
    // Persist sessionId + folderPath to localStorage (survives browser close)
    if (state.folderPath) {
      try {
        const record: LastSessionRecord = {
          sessionId: state.sessionId,
          folderPath: state.folderPath,
          timestamp: new Date().toISOString(),
        };
        localStorage.setItem(matterKey(state.folderPath), JSON.stringify(record));
        localStorage.setItem(LAST_MATTER_KEY, state.folderPath);
      } catch {}
    }
  }, [state]);

  function goToStage(stage: Stage) {
    dispatch({ type: "SET_STAGE", stage });
  }

  return (
    <WorkflowContext.Provider value={{ state, dispatch, goToStage }}>
      {children}
    </WorkflowContext.Provider>
  );
}

export function useWorkflow() {
  const ctx = useContext(WorkflowContext);
  if (!ctx) throw new Error("useWorkflow must be used within WorkflowProvider");
  return ctx;
}
