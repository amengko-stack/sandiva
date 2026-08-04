"use client";

import { createContext, useContext, useReducer, useEffect, useRef, type ReactNode } from "react";
import type { DDAction, DDState } from "@/types/dd";

const STATE_KEY = "sln_dd_state";
const LAST_KEY = "sln_dd_last";

export interface DDLastRecord { sessionId: string; name: string; timestamp: string; }

export function loadLastDDSession(): DDLastRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? (JSON.parse(raw) as DDLastRecord) : null;
  } catch { return null; }
}

function newSessionId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const initialState: DDState = {
  stage: 1,
  sessionId: newSessionId(),
  transaction: null,
  activeEntityId: null,
  progress: {},
  consolidated: false,
  savedToSharePoint: false,
  error: null,
};

function reducer(state: DDState, action: DDAction): DDState {
  switch (action.type) {
    case "SET_STAGE": return { ...state, stage: action.stage, error: null };
    case "SET_TRANSACTION": return { ...state, transaction: action.transaction };
    case "SET_ENTITY_FILES": {
      if (!state.transaction) return state;
      return {
        ...state,
        transaction: {
          ...state.transaction,
          entities: state.transaction.entities.map((e) =>
            e.id === action.entityId ? { ...e, files: action.files } : e
          ),
        },
      };
    }
    case "SET_ACTIVE_ENTITY": return { ...state, activeEntityId: action.entityId };
    case "MARK_PROGRESS": {
      const prev = state.progress[action.entityId] ?? { extracted: false, classified: false, tabled: false, analyzed: false };
      return { ...state, progress: { ...state.progress, [action.entityId]: { ...prev, ...action.patch } } };
    }
    case "SET_CONSOLIDATED": return { ...state, consolidated: action.value };
    case "SET_SAVED": return { ...state, savedToSharePoint: action.value };
    case "SET_ERROR": return { ...state, error: action.error };
    case "HYDRATE": return action.state;
    case "RESET": return { ...initialState, sessionId: newSessionId() };
    default: return state;
  }
}

const DDContext = createContext<{ state: DDState; dispatch: React.Dispatch<DDAction> } | null>(null);

export function DDProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    try {
      const raw = sessionStorage.getItem(STATE_KEY);
      if (raw) dispatch({ type: "HYDRATE", state: JSON.parse(raw) as DDState });
    } catch {}
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
      if (state.transaction) {
        localStorage.setItem(LAST_KEY, JSON.stringify({
          sessionId: state.sessionId,
          name: state.transaction.name,
          timestamp: new Date().toISOString(),
        } satisfies DDLastRecord));
      }
    } catch {}
  }, [state]);

  return <DDContext.Provider value={{ state, dispatch }}>{children}</DDContext.Provider>;
}

export function useDD() {
  const ctx = useContext(DDContext);
  if (!ctx) throw new Error("useDD must be used within DDProvider");
  return ctx;
}
