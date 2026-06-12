export type Stage = 1 | 2 | 3 | 4 | 5;

export interface FileEntry {
  id: string;
  name: string;
  path: string;
  size: string;
  type: string;
  selected: boolean;
}

export type DocCategory = "KRITIS" | "PENDUKUNG" | "REFERENSI";

export type DocDocumentType =
  | "perjanjian_kontrak"
  | "putusan_penetapan"
  | "surat_menyurat"
  | "bukti_transaksi"
  | "dokumen_korporasi"
  | "tidak_dikenali";

export interface DocMapEntry {
  fileId: string;       // matches FileEntry.id
  category: DocCategory;
  documentType: DocDocumentType;
  reasoning: string;
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

// Stage 3C structured strategic assessment — four sections rendered as
// distinct cards; risikoTersembunyi empty array = explicit "none found" state.
export interface StructuredAssessment {
  kekuatan: string[];
  kelemahan: string[];
  risikoTersembunyi: string[];
  rekomendasi: string;
}

export interface StyleExample {
  type: string;
  claimType: string;
  label: string;
  content: string;
  // "setup" = real firm document provided during setup; "approved" =
  // AI draft approved in Stage 5. Setup samples outrank approved drafts.
  source?: "setup" | "approved";
}

export interface ExtractReportFile {
  name: string;
  category: DocCategory;
  documentType: DocDocumentType;
  extractionMode: string;
  status: "selesai" | "gagal" | "perlu_ocr";
  charCount?: number;
  reason?: string;
}

export interface ExtractReport {
  sessionId: string;
  folderPath: string;
  docTypeId: string;
  practiceAreaId: string | null;
  claimType: string | null;
  ref: string;
  timestamp: string;
  files: ExtractReportFile[];
  totalChars: number;
  processed: number;
  skipped: number;
  cacheHits?: number;
  ocrRequired?: number;
}

export interface InterviewAnswer {
  question: string;
  answer: string;
}

export interface DraftMeta {
  ref: string;
  docTypeId: string;
  practiceAreaId: string;
  claimType: string | null;
  pihak: string | null;
  folderPath: string;
}

export interface DraftVersion {
  version: number;
  text: string;
  critiqueItems: string[];
  instructions: string;
  timestamp: string;
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
  docMap: DocMapEntry[];
  selectedFiles: FileEntry[];
  caseAnalysis: CaseAnalysis | null;
  interviewAnswers: InterviewAnswer[];
  strategicAssessment: string;
  userCorrections: string;
  draftText: string;
  isDraftStreaming: boolean;
  draftComplete: boolean;
  critiqueItems: string[];
  isCritiqueLoading: boolean;
  draftVersions: DraftVersion[];
  draftVersion: number;
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
  | { type: "SET_PIHAK"; pihak: string }
  | { type: "SET_SESSION_ID"; id: string }
  | { type: "SET_ALL_FILES"; files: FileEntry[] }
  | { type: "SET_DOC_MAP"; map: DocMapEntry[] }
  | { type: "TOGGLE_FILE"; id: string }
  | { type: "UPDATE_DOC_MAP_ENTRY"; fileId: string; patch: Partial<DocMapEntry> }
  | { type: "SET_SELECTED_FILES"; files: FileEntry[] }
  | { type: "SET_CASE_ANALYSIS"; analysis: CaseAnalysis }
  | { type: "SET_INTERVIEW_ANSWERS"; answers: InterviewAnswer[] }
  | { type: "SET_STRATEGIC_ASSESSMENT"; text: string }
  | { type: "SET_USER_CORRECTIONS"; text: string }
  | { type: "APPEND_DRAFT"; chunk: string }
  | { type: "RESET_DRAFT" }
  | { type: "SET_DRAFT_STREAMING"; value: boolean }
  | { type: "SET_DRAFT_COMPLETE"; value: boolean }
  | { type: "SET_CRITIQUE"; items: string[] }
  | { type: "SET_CRITIQUE_LOADING"; value: boolean }
  | { type: "ADD_DRAFT_VERSION"; version: DraftVersion }
  | { type: "SET_DRAFT_VERSION"; version: number }
  | { type: "SET_REF"; ref: string }
  | { type: "SET_SAVED_SHAREPOINT"; value: boolean }
  | { type: "SET_APPROVED_MEMORY"; value: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "RESET" };
