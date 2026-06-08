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
  selectedFiles: [],
  caseAnalysis: null,
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

    case "SET_ALL_FILES":
      return { ...state, allFiles: action.files };

    case "TOGGLE_FILE":
      return {
        ...state,
        allFiles: state.allFiles.map((f) =>
          f.id === action.id ? { ...f, selected: !f.selected } : f
        ),
      };

    case "SET_SELECTED_FILES":
      return { ...state, selectedFiles: action.files };

    case "SET_CASE_ANALYSIS":
      return { ...state, caseAnalysis: action.analysis };

    case "SET_USER_CORRECTIONS":
      return { ...state, userCorrections: action.text };

    case "APPEND_DRAFT":
      return { ...state, draftText: state.draftText + action.chunk };

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
