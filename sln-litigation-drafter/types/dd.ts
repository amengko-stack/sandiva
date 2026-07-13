import type { FileEntry, ExtractReport } from "./index";

export type DDStage = 1 | 2 | 3 | 4 | 5 | 6;

export type DDTransactionType =
  | "akuisisi_saham"
  | "akuisisi_aset"
  | "merger"
  | "likuidasi"
  | "divestasi"
  | "streamlining"
  | "joint_venture";

export type DDAspectId =
  | "pendirian_ad"
  | "permodalan_saham"
  | "pengurus"
  | "perizinan"
  | "harta_kekayaan"
  | "perjanjian_penting"
  | "ketenagakerjaan"
  | "perpajakan"
  | "asuransi"
  | "perkara";

export type DDImportance = "wajib" | "penting" | "opsional";
export type DDGapStatus = "present" | "incomplete" | "expired" | "missing" | "not_applicable";
export type DDSeverity = "kritis" | "material" | "minor";
export type DDDimension = "kelengkapan" | "currency" | "risiko" | "konsistensi";
export type DDConfidence = "tinggi" | "sedang" | "rendah";
export type DDCurrencyStatus = "current" | "superseded" | "unknown";
export type DDFindingReviewStatus = "open" | "accepted" | "dismissed" | "edited";
export type DDCellType = "text" | "date" | "currency" | "number" | "verbatim" | "category" | "boolean";

export interface DDExpiryRule {
  kind: "fixed_years" | "none";
  years?: number; // required when kind === "fixed_years"
}

export interface DDExpectedDoc {
  id: string;               // "<aspectId>.<slug>", e.g. "permodalan_saham.akta_perubahan_modal"
  aspectId: DDAspectId;
  label: string;
  importance: DDImportance;
  keywords: string[];       // filename/content hints for the classifier
  expiryRule?: DDExpiryRule;
  appliesTo?: DDTransactionType[]; // omitted = applies to all transaction types
  source: "base" | "overlay" | "ai_tailored";
}

// One key-terms column definition (Harvey review-table style).
export interface DDExtractionField {
  id: string;               // "change_of_control"
  label: string;            // "Change of Control / Persetujuan"
  type: DDCellType;
  prompt: string;           // what to extract, in Indonesian
  appliesToKeywords: string[]; // agreement-name keywords this column applies to ([] = all agreements)
  dealTriggerFor?: DDTransactionType[]; // presence of this clause = red flag for these deal types
}

export interface DDChecklist {
  version: string;
  updatedAt: string;        // ISO
  base: DDExpectedDoc[];
  overlays: Partial<Record<DDTransactionType, DDExpectedDoc[]>>;
  extractionFields: DDExtractionField[];
}

export interface ResolvedChecklist {
  version: string;
  expected: DDExpectedDoc[];       // base ∪ overlay[txn] ∪ tailored, filtered by appliesTo
  extractionFields: DDExtractionField[];
}

export interface DDEntity {
  id: string;               // short slug, validated by isValidEntityId
  name: string;             // "PT Alpha Sentosa"
  role: string;             // "target" | "penjual" | "pembeli" | free text
  dataRoomPath: string;     // SharePoint folder path / sharing link
  files: FileEntry[];
}

export interface DDTransaction {
  id: string;               // = sessionId
  name: string;             // matter label, used in deliverable filenames
  type: DDTransactionType;
  clientRole: string;       // who the firm acts for
  cutoffDateISO: string;    // "YYYY-MM-DD" — expiry comparisons use this date
  entities: DDEntity[];
  checklistVersion: string;
}

export interface DDClassifiedDoc {
  fileName: string;
  entityId: string;
  aspectId: DDAspectId;
  expectedDocId: string | null;  // checklist item this doc satisfies, or null
  docLabel: string;              // human title, e.g. "Akta Pendirian No. 12/2015"
  docDate: string | null;        // "YYYY-MM-DD" | "YYYY-MM" | "YYYY" | null
  parties: string[];
  summary: string;               // 1–2 sentences
  confidence: DDConfidence;
  reasoning: string;
}

export interface DDGapItem {
  entityId: string;
  aspectId: DDAspectId;
  expectedDocId: string;
  expectedLabel: string;
  status: DDGapStatus;
  matchedFiles: string[];
  severity: DDSeverity;
  note: string;
}

export interface DDCell {
  fieldId: string;
  type: DDCellType;
  value: string;            // typed value as string ("—" when absent)
  verbatim: string;         // exact quote from the document ("" when absent)
  sourceFile: string;       // which member file the quote came from
  dealTriggered: boolean;
}

export interface DDExtractionRow {
  groupId: string;
  entityId: string;
  agreementLabel: string;
  memberFiles: string[];    // contract + amendments, ≤ 25
  cells: DDCell[];
  status: "selesai" | "gagal";
  reason?: string;
}

export interface DDFinding {
  id: string;               // `${entityId}-${dimension}-${n}` assigned server-side
  entityId: string;         // entity id, or "consolidated"
  aspectId: DDAspectId | null;
  dimension: DDDimension;
  severity: DDSeverity;
  anchor: string;           // verbatim quote from source ("" for gap findings)
  sourceFile: string | null;
  problem: string;
  whyItMatters: string;
  suggestedFix: string;
  regulationRefs?: string[];
  currencyStatus?: DDCurrencyStatus;
  currencyNote?: string;
  verified: boolean;
  status: DDFindingReviewStatus;
  editedProblem?: string;   // lawyer's replacement text when status === "edited"
}

export interface DDTailorResult {
  added: DDExpectedDoc[];
  notApplicableSuggestions: { expectedDocId: string; reason: string }[];
}

export interface DDDocGroup {
  groupId: string;          // `${entityId}-grp-${n}`
  label: string;
  memberFiles: string[];
}

export interface DDAspectRollup {
  aspectId: DDAspectId;
  totalExpected: number;
  present: number;
  missing: number;
  incomplete: number;
  expired: number;
  notApplicable: number;
}

export interface DDConsolidated {
  transactionType: DDTransactionType;
  crossEntityFindings: DDFinding[];
  aspectRollup: DDAspectRollup[];
  generatedAt: string;      // ISO
}

export interface DDEntityResult {
  entity: DDEntity;
  classified: DDClassifiedDoc[];
  gaps: DDGapItem[];
  rows: DDExtractionRow[];
  findings: DDFinding[];
  extractReport: ExtractReport | null;
}

// ---------- client wizard state ----------

export interface DDEntityProgress {
  extracted: boolean;
  classified: boolean;
  tabled: boolean;
  analyzed: boolean;
}

export interface DDState {
  stage: DDStage;
  sessionId: string;
  transaction: DDTransaction | null;
  activeEntityId: string | null;
  progress: Record<string, DDEntityProgress>;
  consolidated: boolean;
  savedToSharePoint: boolean;
  error: string | null;
}

export type DDAction =
  | { type: "SET_STAGE"; stage: DDStage }
  | { type: "SET_TRANSACTION"; transaction: DDTransaction }
  | { type: "SET_ENTITY_FILES"; entityId: string; files: FileEntry[] }
  | { type: "SET_ACTIVE_ENTITY"; entityId: string | null }
  | { type: "MARK_PROGRESS"; entityId: string; patch: Partial<DDEntityProgress> }
  | { type: "SET_CONSOLIDATED"; value: boolean }
  | { type: "SET_SAVED"; value: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "HYDRATE"; state: DDState }
  | { type: "RESET" };
