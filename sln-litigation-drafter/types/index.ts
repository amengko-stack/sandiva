export type Stage = 1 | 2 | 3 | 4 | 5;

export interface FileEntry {
  id: string;
  name: string;
  path: string;
  size: string;
  type: string;
  selected: boolean;
}

export interface CaseAnalysis {
  identitasPihak: string;
  hubunganHukum: string;
  kronologi: string;
  elemenHukum: string;
  analisisElemen: string;
  buktiKunci: string;
  kelemahanGaps: string;
  posisiHukum: string;
}

export interface MemoryLibrary {
  conventions: string;
  patterns: {
    totalDrafts: number;
    patterns: PatternEntry[];
  };
  styleExamples: StyleExample[];
}

export interface PatternEntry {
  docType: string;
  claimType: string;
  note: string;
  date: string;
}

export interface StyleExample {
  type: string;
  claimType: string;
  label: string;
  content: string;
}

export interface DraftMeta {
  ref: string;
  docTypeId: string;
  practiceAreaId: string;
  claimType: string | null;
  pihak: string | null;
  folderPath: string;
}

export interface WorkflowState {
  stage: Stage;
  sessionId: string;
  practiceAreaId: string | null;
  docTypeId: string | null;
  claimType: string | null;
  pihak: string | null;
  folderPath: string;
  allFiles: FileEntry[];
  selectedFiles: FileEntry[];
  caseAnalysis: CaseAnalysis | null;
  userCorrections: string;
  draftText: string;
  isDraftStreaming: boolean;
  draftComplete: boolean;
  critiqueText: string;
  isCritiqueLoading: boolean;
  ref: string;
  savedToSharePoint: boolean;
  approvedForMemory: boolean;
  error: string | null;
}

export type WorkflowAction =
  | { type: "SET_STAGE"; stage: Stage }
  | {
      type: "SET_SELECTION";
      practiceAreaId: string;
      docTypeId: string;
      claimType: string | null;
      pihak: string | null;
    }
  | { type: "SET_FOLDER"; folderPath: string }
  | { type: "SET_ALL_FILES"; files: FileEntry[] }
  | { type: "TOGGLE_FILE"; id: string }
  | { type: "SET_SELECTED_FILES"; files: FileEntry[] }
  | { type: "SET_CASE_ANALYSIS"; analysis: CaseAnalysis }
  | { type: "SET_USER_CORRECTIONS"; text: string }
  | { type: "APPEND_DRAFT"; chunk: string }
  | { type: "SET_DRAFT_STREAMING"; value: boolean }
  | { type: "SET_DRAFT_COMPLETE"; value: boolean }
  | { type: "SET_CRITIQUE"; text: string }
  | { type: "SET_CRITIQUE_LOADING"; value: boolean }
  | { type: "SET_REF"; ref: string }
  | { type: "SET_SAVED_SHAREPOINT"; value: boolean }
  | { type: "SET_APPROVED_MEMORY"; value: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "RESET" };
