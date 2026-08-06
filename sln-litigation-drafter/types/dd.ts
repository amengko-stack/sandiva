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

/**
 * Whether a quote the report attributes to a document is actually in it. Declared
 * here so DDFinding can be precisely typed without a cast; the checks live in
 * lib/dd/grounding.ts.
 */
export type DDGroundingVerdict =
  | "verified"
  | "paraphrased"
  | "not_found"
  | "source_missing"
  | "no_quote";
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

/**
 * Which report format to render. Format is a DELIVERABLE choice driven by what
 * the client needs, not something derivable from the data room — the firm's own
 * samples use two different shapes for the same kind of work.
 *
 * "pendahuluan_led"  — BAB I Pendahuluan, BAB II Profil, then analysis chapters
 *                      per aspect (as in the SIIB and ITDC reports).
 * "exec_summary_led" — opens with Ringkasan Eksekutif, then chapters by DOCUMENT
 *                      CATEGORY with description and analysis fused (as in the
 *                      SBN divestment reports).
 * "lut_pasar_modal"  — the capital-markets LUT. Not a free choice: where the
 *                      target is Tbk and the report feeds a prospectus, HKHSK
 *                      Annex VII / POJK 7/2017 prescribe the content.
 * "findings_only"    — exceptions and recommendations, no profile chapter.
 */
export type DDReportFormat =
  | "pendahuluan_led"
  | "exec_summary_led"
  | "lut_pasar_modal"
  | "findings_only";

/**
 * Presentation options that vary between the firm's own reports, so none of
 * them can be hardcoded.
 *
 * riskColumn deserves a note. The Makarim precedents and the HKHSK standard use
 * no risk rating at all, and I first read that as a rule and banned it. The
 * firm's own reports disagree: the SBN divestment report has none, ITDC uses
 * plain words ("Tinggi" / "Rendah-Sedang"), and SIIB uses bracket codes
 * ("Sedang [S]"). So it is a per-report choice, and the correct default is the
 * convention (off) with both house notations available.
 */
export interface DDReportOptions {
  riskColumn: "off" | "kata" | "kode";
  legalConsequenceColumn: boolean;
  bilingualHeadings: boolean;
  includeTimPemeriksa: boolean;
  /** Per-chapter "Implikasi terhadap <transaksi>" sub-section. */
  transactionImplications: boolean;
}

export const DD_DEFAULT_REPORT_OPTIONS: DDReportOptions = {
  riskColumn: "off",
  legalConsequenceColumn: true,
  bilingualHeadings: false,
  includeTimPemeriksa: false,
  transactionImplications: false,
};

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
  /**
   * Whether the examination is complete.
   *
   * Clients hand over documents in batches, and findings prompt requests for
   * more, so a report is normally issued interim first and final once the data
   * room is closed. Required rather than defaulted: a report that presents itself
   * as final while documents are outstanding is a professional problem, and the
   * compiler should make every call site say which one it is producing.
   */
  reportStage: "interim" | "final";
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
  /** Absent = "pendahuluan_led", preserving the behaviour of existing sessions. */
  reportFormat?: DDReportFormat;
  reportOptions?: DDReportOptions;
}

/**
 * One rendered element of the report. Declared here rather than in a renderer so
 * the boilerplate and narrative renderers can both emit it without importing
 * each other (narrative-render already depends on report-boilerplate for date
 * formatting, so the reverse import would cycle).
 */
export type DDReportBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "note"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "defs"; rows: [string, string][] }
  | { kind: "table"; headers: string[]; rows: string[][] };

// ---------- narrative layer (Bagian I) ----------
// The precedents lead with a DESCRIPTION of what the documents say, with the
// citation chain woven into the prose, and raise issues as an indented "Catatan:"
// attached to the relevant passage. The pipeline previously produced only
// exceptions (a gap matrix plus severity-tagged findings), which is working-paper
// vocabulary, not a client report. These types carry the facts that description
// needs. Every entry keeps its source file and a verbatim quote so no sentence in
// the report is unattributable.

/**
 * A snapshot of what an issued report covered, kept so a later supplement can say
 * what changed rather than guess.
 *
 * Only what is needed to diff: the documents examined, the checklist items still
 * outstanding, and a reduced record of each finding. Not the whole report — a
 * supplement describes changes, and storing a second copy of the report would
 * invite the two to drift apart.
 */
export interface DDExaminedDoc {
  fileName: string;
  /**
   * Digest of the extracted text.
   *
   * File name alone is not an identity: a data room routinely replaces a document
   * under the same name — a re-scan, a signed version, a corrected page. Diffing on
   * names alone, that document compares equal, drops out of the supplement's list
   * of what is new, and its changed contents and any findings from them go
   * unreported. The digest is of the extracted TEXT rather than the bytes, because
   * the text is what the examination and the quote checks actually read.
   */
  digest: string;
}

export interface DDBaseline {
  entityId: string;
  /** When the report this baseline records was issued. */
  issuedAtISO: string;
  cutoffDateISO: string;
  /** The documents examined, sorted by file name. */
  documents: DDExaminedDoc[];
  /** Checklist item ids that were missing or incomplete. */
  outstandingDocIds: string[];
  findings: {
    id: string;
    aspectId: DDAspectId | null;
    sourceFile: string | null;
    severity: DDSeverity;
    /** The lawyer's wording where they replaced the model's. */
    problem: string;
    status: DDFindingReviewStatus;
  }[];
}

/** What a supplement has to report, all of it derived and none of it inferred. */
export interface DDSupplementDiff {
  baselineIssuedAtISO: string;
  baselineCutoffDateISO: string;
  cutoffDateISO: string;
  /**
   * Documents examined now that were not part of the earlier examination — either
   * absent from it, or present under the same name with different content.
   */
  newDocuments: string[];
  documentsExaminedNow: number;
  /**
   * Requested documents the current gap analysis affirmatively records as supplied.
   * Never inferred from a checklist id merely disappearing.
   */
  gapsClosed: string[];
  /**
   * Items that left the outstanding list without being supplied — marked not
   * applicable, or no longer on the checklist at all. Separate from gapsClosed,
   * because reporting these as supplied would assert receipt of a document nobody
   * has seen.
   */
  gapsNoLongerListed: string[];
  /**
   * Requirements outstanding for the first time in this examination. Deliberately
   * NOT described as revealed BY the new documents: set arithmetic shows only that
   * the item was not outstanding before, and a checklist edit or a regime change
   * produces the same result. Causation would need provenance the baseline does not
   * record.
   */
  gapsFirstListedNow: string[];
  /** Outstanding at the earlier report and still outstanding now. */
  gapsStillOutstanding: string[];
  /**
   * Documents listed as examined whose text could not be read. Reported rather
   * than counted in silently: a document nobody could extract was not examined,
   * and saying it was is a claim the data does not support.
   */
  documentsUnreadable: string[];
  /**
   * Findings whose source document is one of the new ones AND which the earlier
   * report did not already raise. The second half matters because a document
   * replaced under the same name counts as new, and every finding bearing that
   * file name would otherwise be presented as arising from the replacement —
   * including ones raised from the earlier version and merely carried forward.
   */
  findingsFromNewDocuments: DDFinding[];
  /**
   * Findings the earlier report raised that this examination does not. Reported
   * for the lawyer to resolve, never treated as automatically cured: only a
   * lawyer can conclude that an earlier finding no longer stands.
   */
  findingsNoLongerRaised: DDBaseline["findings"];
  /**
   * Findings the examination still raises but the lawyer has dismissed since the
   * earlier report. The client read them and will not find them next time, so they
   * have to be accounted for — and the cause is a review decision, not a change in
   * the documents, which is why they are not in findingsNoLongerRaised.
   */
  findingsDismissedSinceBaseline: DDBaseline["findings"];
  findingsCarriedForward: number;
  /**
   * Of those carried forward, how many are materially identical — same severity
   * and same problem text as the issued report. A persisting id is not evidence
   * of that on its own: the identity is deliberately blind to severity and
   * wording so that a reworded finding stays the same finding, which is exactly
   * why "unchanged" has to be checked rather than assumed.
   */
  findingsCarriedUnchanged: number;
  /** Carried forward but revised in severity or wording since the earlier report. */
  findingsCarriedRevised: DDBaseline["findings"];
}

export interface DDDeedRef {
  number: string;          // "16"
  dateISO: string;         // "2009-04-15" (or "" when illegible)
  notary: string;          // "Raden Johanes Sarwono, S.H., Notaris di Jakarta"
  purpose: string;         // "Pendirian" | "Perubahan Pasal 3 dan Dewan Komisaris"
  menkumhamRef: string;    // approval/notification number + date ("" if absent)
  registrationRef: string; // company-registry / TDP-NIB reference ("" if absent)
  bnriRef: string;         // State Gazette no. + date + supplement ("" if absent)
  sourceFile: string;
  verbatim: string;
}

export interface DDCapitalEntry {
  basis: string;           // which deed established this structure
  authorized: string;      // modal dasar, as written
  issued: string;          // modal ditempatkan
  paidUp: string;          // modal disetor
  shareCount: string;
  nominalPerShare: string;
  sourceFile: string;
}

export interface DDShareholderEntry {
  name: string;
  shares: string;
  amount: string;
  percentage: string;
  sourceFile: string;
}

export interface DDOfficerEntry {
  role: string;            // "Direktur Utama" | "Komisaris"
  name: string;
  appointedBy: string;     // deed reference
  termUntil: string;       // as stated ("" when not stated)
  sourceFile: string;
}

/** A qualification attached to a specific passage, rendered as "Catatan:". */
export interface DDNarrativeNote {
  /** Which sub-section the note belongs under. */
  anchor:
    | "pendirian"
    | "anggaran_dasar"
    | "kegiatan_usaha"
    | "permodalan"
    | "pemegang_saham"
    | "pengurus"
    // Catch-all. A note whose anchor cannot be resolved is rendered under its
    // own heading rather than filed under a guessed sub-section: misplacing a
    // qualification is worse than presenting it separately.
    | "lainnya";
  text: string;
  sourceFile: string | null;
}

export interface DDNarrativeSectionI {
  entityId: string;
  establishment: DDDeedRef | null;
  amendments: DDDeedRef[];
  businessPurpose: string;      // maksud dan tujuan, as stated in the AoA
  businessActivities: string[]; // kegiatan usaha
  businessBasis: string;        // which deed/article states them
  capitalHistory: DDCapitalEntry[];
  currentCapital: DDCapitalEntry | null;
  shareholders: DDShareholderEntry[];
  directors: DDOfficerEntry[];
  commissioners: DDOfficerEntry[];
  notes: DDNarrativeNote[];
  generatedAt: string;         // ISO
}

/**
 * The analysis body of one sub-section of an analysis chapter (BAB III onwards).
 *
 * Without this the analysis chapters rendered as hollow scaffolding: every
 * sub-section carried the same templated sentence with its own title substituted
 * in, and all findings piled into the chapter's single "Temuan" sub-section. The
 * reference report instead puts real legal analysis under each numbered topic —
 * the applicable provision, the facts from the profile chapter, the conclusion on
 * compliance — plus a purpose-built table where one helps (e.g. an RUPS register
 * derived from the same deeds the profile chapter tabulates).
 */
export interface DDSubsectionAnalysis {
  aspectId: DDAspectId;
  /** Must match a DDChapterSub.title so the builder can place it. */
  subsectionTitle: string;
  /** Paragraphs: applicable provision, application to the facts, conclusion. */
  analysis: string[];
  /** What could not be established and must be verified. May be empty. */
  verification: string[];
  /** Optional table where a register reads better than prose. */
  table?: { headers: string[]; rows: string[][] };
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
  /**
   * The legal consequence of the non-compliance: either the sanction with the
   * article imposing it, or an explicit statement that none attaches plus the
   * civil/corporate consequence.
   *
   * This is a first-class field rather than prose inside whyItMatters because
   * asking for it in the prompt alone did not work — a live run produced it in
   * 0 of 17 findings, since there was no slot for it and no way to detect its
   * absence. A named field the model must fill is enforceable; a buried
   * instruction is not.
   */
  legalConsequence?: string;
  /** Sub-section this finding belongs under; falls back to the chapter's Temuan. */
  subsectionTitle?: string;
  /**
   * Whether the anchor quote was actually found in the document it is attributed
   * to. Checked deterministically after parsing, because nothing previously
   * verified that a "verbatim quote" was verbatim — or even from that file.
   * Absent on findings generated in code, which quote nothing.
   */
  grounding?: { verdict: DDGroundingVerdict; coverage: number; note: string };
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
  /** Bagian I narrative; null when the narrative stage has not been run. */
  narrative?: DDNarrativeSectionI | null;
  /** Per-sub-section analysis for the analysis chapters; empty before Stage 5. */
  analyses?: DDSubsectionAnalysis[];
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
