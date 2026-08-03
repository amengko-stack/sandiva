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

// ---------- listing status & applicable-regime axis ----------
// A PT Tertutup is bound by UUPT only; a PT Tbk carries the capital-markets
// overlay (UUPM/OJK/IDX) on top. A private company whose ultimate parent is Tbk
// is itself unbound, but its transaction can be a Transaksi Material *for the
// parent* — POJK 17/2020 covers transactions by a "Perusahaan Terbuka atau
// perusahaan terkendali", measured against the parent's figures.
export type DDListingStatus = "tbk" | "non_tbk";

export type DDRegimeLayer =
  | "uupt"                  // baseline, always applies
  | "pasar_modal_langsung"  // entity is itself Tbk
  | "pasar_modal_induk"     // entity is private but has a Tbk ultimate parent
  | "bumn";                 // state-owned layer (question framework only)

export interface DDRegime {
  layers: DDRegimeLayer[];
  capitalMarkets: boolean;      // any pasar_modal layer active
  parentTbkName: string | null; // set only when "pasar_modal_induk" is active
}

// Report conclusions use the tri-state form mandated by the professional
// standard, NOT a severity histogram. "memenuhi_dengan_catatan" obliges the
// note to spell out the legal risk.
export type DDComplianceVerdict =
  | "memenuhi"
  | "memenuhi_dengan_catatan"
  | "tidak_memenuhi";

export type DDImportance = "wajib" | "penting" | "opsional";
export type DDGapStatus = "present" | "incomplete" | "expired" | "missing" | "not_applicable";
export type DDSeverity = "kritis" | "material" | "minor";
export type DDDimension = "kelengkapan" | "currency" | "risiko" | "konsistensi";
export type DDConfidence = "tinggi" | "sedang" | "rendah";
// "amended" exists because conflating it with "superseded" made the check
// actively misleading: a live run marked eight in-force UUPT articles
// "superseded" merely because UU Cipta Kerja amended the statute elsewhere.
// A provision still in force but reworded is materially different from one
// that has been repealed, and only the latter should alarm the reader.
export type DDCurrencyStatus = "current" | "amended" | "superseded" | "unknown";
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
  requiresLayer?: DDRegimeLayer[]; // omitted = regime-independent; else only when one of these layers is active
  source: "base" | "overlay" | "regime" | "ai_tailored";
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
  regimeOverlays?: Partial<Record<DDRegimeLayer, DDExpectedDoc[]>>;
  extractionFields: DDExtractionField[];
}

export interface ResolvedChecklist {
  version: string;
  expected: DDExpectedDoc[];       // base ∪ overlay[txn] ∪ regimeOverlay[layers] ∪ tailored, filtered by appliesTo/requiresLayer
  extractionFields: DDExtractionField[];
}

export interface DDEntity {
  id: string;               // short slug, validated by isValidEntityId
  name: string;             // "PT Alpha Sentosa"
  role: string;             // "target" | "penjual" | "pembeli" | free text
  dataRoomPath: string;     // SharePoint folder path / sharing link
  files: FileEntry[];
  // Optional so sessions persisted before the regime axis existed still hydrate;
  // resolveRegime() treats an absent listingStatus as "non_tbk".
  listingStatus?: DDListingStatus;
  ultimateParentTbk?: string; // name of the Tbk ultimate parent; "" / absent = none
  isBumn?: boolean;
}

// Fields a report needs that cannot be inferred from the data room.
export interface DDReportMeta {
  matterRef: string;         // firm matter / reference number
  clientName: string;        // client on whose instruction the DD was run
  addressee: string;         // to whom the report is addressed
  relianceScope: string;     // who may rely on the report (gates the reliance clause)
  clientRelease: boolean;    // false = draft/internal watermark, no client release
  ddStartDateISO: string;    // "YYYY-MM-DD" — start of the examination period
  taxInScope: boolean;       // whether tax was within the agreed scope
  assumptionsVariant: "ringkas" | "panjang"; // (i)–(iv) vs the 11-item (a)–(k) variant
  signatoryName: string;
  signatoryTitle: string;
}

export interface DDTransaction {
  id: string;               // = sessionId
  name: string;             // matter label, used in deliverable filenames
  type: DDTransactionType;
  clientRole: string;       // who the firm acts for
  cutoffDateISO: string;    // "YYYY-MM-DD" — expiry comparisons use this date
  entities: DDEntity[];
  checklistVersion: string;
  reportMeta?: DDReportMeta; // absent = builder falls back to placeholders
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
