// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface DocTypeConfig {
  id: string;
  label: string;
  claimTypes: { id: string; label: string }[]; // kept for compat; always [] in new flow
  hasPihak: boolean;
  promptKey: string;
}

export interface ClaimTypeEntry {
  id: string;
  label: string;
  statute: string;
}

export interface ForumConfig {
  id: string;
  label: string;
  types: ClaimTypeEntry[];
}

// ─── Forum → Jenis Gugatan hierarchy (three-level step 1 + 2) ─────────────────

export const CLAIM_TYPES: ForumConfig[] = [
  {
    id: "pn_umum",
    label: "Pengadilan Negeri — Perdata Umum",
    types: [
      { id: "wanprestasi",           label: "Wanprestasi",                         statute: "Pasal 1243 KUH Perdata" },
      { id: "pmh",                   label: "Perbuatan Melawan Hukum",              statute: "Pasal 1365 KUH Perdata" },
      { id: "pembatalan_perjanjian", label: "Pembatalan Perjanjian",               statute: "Pasal 1320 jo. 1449 KUH Perdata" },
      { id: "pmh_penguasa",          label: "PMH oleh Penguasa (OOD)",             statute: "Pasal 1365 KUH Perdata jo. SEMA" },
      { id: "kepemilikan",           label: "Gugatan Kepemilikan / Bezit",         statute: "Pasal 570 KUH Perdata" },
      { id: "waris",                 label: "Gugatan Waris",                        statute: "KUH Perdata Buku II" },
      { id: "piercing",              label: "Tanggung Jawab Korporasi / Piercing", statute: "Pasal 3 jo. 97 UUPT" },
    ],
  },
  {
    id: "pn_niaga_korporasi",
    label: "Pengadilan Negeri — Korporasi",
    types: [
      { id: "pembatalan_rups",        label: "Pembatalan RUPS",                    statute: "Pasal 61 UUPT" },
      { id: "tanggung_jawab_direksi", label: "Tanggung Jawab Direksi/Komisaris",   statute: "Pasal 97 UUPT" },
      { id: "pembubaran_pt",          label: "Pembubaran PT",                      statute: "Pasal 146 UUPT" },
      { id: "gugatan_derivatif",      label: "Gugatan Derivatif Pemegang Saham",   statute: "Pasal 61 UUPT" },
    ],
  },
  {
    id: "pn_niaga_insolvency",
    label: "Pengadilan Niaga — PKPU & Kepailitan",
    types: [
      { id: "pkpu",                  label: "Permohonan PKPU",      statute: "Pasal 222 UU 37/2004" },
      { id: "pailit",                label: "Permohonan Pailit",    statute: "Pasal 2 UU 37/2004" },
      { id: "actio_pauliana",        label: "Actio Pauliana",       statute: "Pasal 41 UU 37/2004" },
      { id: "pembatalan_perdamaian", label: "Pembatalan Perdamaian",statute: "Pasal 291 UU 37/2004" },
    ],
  },
  {
    id: "pn_niaga_hki",
    label: "Pengadilan Niaga — HKI",
    types: [
      { id: "merek",     label: "Pelanggaran Merek",     statute: "UU No. 20 Tahun 2016" },
      { id: "hak_cipta", label: "Pelanggaran Hak Cipta", statute: "UU No. 28 Tahun 2014" },
      { id: "paten",     label: "Pelanggaran Paten",     statute: "UU No. 13 Tahun 2016" },
    ],
  },
  {
    id: "ptun",
    label: "Pengadilan Tata Usaha Negara",
    types: [
      { id: "pembatalan_ktun", label: "Pembatalan Keputusan TUN", statute: "UU No. 51 Tahun 2009" },
      { id: "pmh_pemerintah",  label: "PMH Pemerintah",           statute: "Pasal 1365 KUH Perdata jo. PERMA 2/2019" },
    ],
  },
  {
    id: "arbitrase",
    label: "Arbitrase",
    types: [
      { id: "bani",  label: "BANI",   statute: "UU No. 30 Tahun 1999" },
      { id: "siac",  label: "SIAC",   statute: "SIAC Rules 2016" },
      { id: "icc",   label: "ICC",    statute: "ICC Rules 2021" },
      { id: "adhoc", label: "Ad Hoc", statute: "UU No. 30 Tahun 1999" },
    ],
  },
];

// ─── Doc Type configs ──────────────────────────────────────────────────────────

const CIVIL_DOC_TYPES: DocTypeConfig[] = [
  { id: "gugatan",    label: "Gugatan",    claimTypes: [], hasPihak: false, promptKey: "gugatan" },
  { id: "jawaban",    label: "Jawaban",    claimTypes: [], hasPihak: false, promptKey: "jawaban" },
  { id: "replik",     label: "Replik",     claimTypes: [], hasPihak: false, promptKey: "replik" },
  { id: "duplik",     label: "Duplik",     claimTypes: [], hasPihak: false, promptKey: "duplik" },
  { id: "kesimpulan", label: "Kesimpulan", claimTypes: [], hasPihak: true,  promptKey: "kesimpulan" },
];

const INSOLVENCY_DOC_TYPES: DocTypeConfig[] = [
  { id: "permohonan_pkpu",    label: "Permohonan PKPU",                     claimTypes: [], hasPihak: false, promptKey: "permohonan_pkpu" },
  { id: "permohonan_pailit",  label: "Permohonan Pailit",                   claimTypes: [], hasPihak: false, promptKey: "permohonan_pailit" },
  { id: "jawaban_pkpu",       label: "Jawaban atas Permohonan PKPU/Pailit", claimTypes: [], hasPihak: false, promptKey: "jawaban_pkpu" },
  { id: "rencana_perdamaian", label: "Rencana Perdamaian",                  claimTypes: [], hasPihak: false, promptKey: "rencana_perdamaian" },
  { id: "kesimpulan_pkpu",    label: "Kesimpulan PKPU/Kepailitan",           claimTypes: [], hasPihak: true,  promptKey: "kesimpulan_pkpu" },
];

const ARBITRASE_DOC_TYPES: DocTypeConfig[] = [
  { id: "surat_tuntutan",       label: "Surat Tuntutan",       claimTypes: [], hasPihak: false, promptKey: "surat_tuntutan" },
  { id: "statement_of_defense", label: "Statement of Defense", claimTypes: [], hasPihak: false, promptKey: "statement_of_defense" },
  { id: "reply_arb",            label: "Reply",                claimTypes: [], hasPihak: false, promptKey: "reply_arb" },
  { id: "rejoinder",            label: "Rejoinder",            claimTypes: [], hasPihak: false, promptKey: "rejoinder" },
  { id: "closing_submission",   label: "Closing Submission",   claimTypes: [], hasPihak: true,  promptKey: "closing_submission" },
];

// ─── Forum → available doc types ──────────────────────────────────────────────

export const FORUM_DOC_TYPES: Record<string, DocTypeConfig[]> = {
  pn_umum:             CIVIL_DOC_TYPES,
  pn_niaga_korporasi:  CIVIL_DOC_TYPES,
  pn_niaga_insolvency: INSOLVENCY_DOC_TYPES,
  pn_niaga_hki:        CIVIL_DOC_TYPES,
  ptun:                CIVIL_DOC_TYPES,
  arbitrase:           ARBITRASE_DOC_TYPES,
};

// For insolvency: jenis gugatan filters which doc types appear
export const INSOLVENCY_CLAIM_DOC_TYPES: Record<string, string[]> = {
  pkpu:                  ["permohonan_pkpu", "jawaban_pkpu", "rencana_perdamaian", "kesimpulan_pkpu"],
  pailit:                ["permohonan_pailit", "jawaban_pkpu", "rencana_perdamaian", "kesimpulan_pkpu"],
  actio_pauliana:        ["gugatan", "jawaban", "replik", "duplik", "kesimpulan"],
  pembatalan_perdamaian: ["gugatan", "jawaban", "replik", "duplik", "kesimpulan"],
};

// All doc types flattened for findDocType lookups
const ALL_DOC_TYPES = [
  ...CIVIL_DOC_TYPES,
  ...INSOLVENCY_DOC_TYPES,
  ...ARBITRASE_DOC_TYPES,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getClaimTypesForForum(forumId: string): ClaimTypeEntry[] {
  return CLAIM_TYPES.find((f) => f.id === forumId)?.types ?? [];
}

export function getForumDocTypes(forumId: string, claimTypeId?: string): DocTypeConfig[] {
  if (forumId === "pn_niaga_insolvency" && claimTypeId) {
    const allowed = INSOLVENCY_CLAIM_DOC_TYPES[claimTypeId];
    if (allowed) {
      // actio_pauliana and pembatalan_perdamaian use civil doc types
      const sourceList = ["actio_pauliana", "pembatalan_perdamaian"].includes(claimTypeId)
        ? CIVIL_DOC_TYPES
        : INSOLVENCY_DOC_TYPES;
      return sourceList.filter((d) => allowed.includes(d.id));
    }
  }
  return FORUM_DOC_TYPES[forumId] ?? [];
}

export function getClaimTypeLabel(claimTypeId: string): string {
  for (const forum of CLAIM_TYPES) {
    const found = forum.types.find((t) => t.id === claimTypeId);
    if (found) return found.label;
  }
  return claimTypeId;
}

export function resolveForumLabel(forumId: string): string {
  return CLAIM_TYPES.find((f) => f.id === forumId)?.label ?? forumId;
}

export function findDocType(forumId: string, docTypeId: string): DocTypeConfig | undefined {
  const inForum = (FORUM_DOC_TYPES[forumId] ?? []).find((d) => d.id === docTypeId);
  return inForum ?? ALL_DOC_TYPES.find((d) => d.id === docTypeId);
}

// ─── Reference generation ─────────────────────────────────────────────────────

export const DOC_TYPE_CODES: Record<string, string> = {
  gugatan:              "GUG",
  jawaban:              "JAW",
  replik:               "RPL",
  duplik:               "DPL",
  kesimpulan:           "KSP",
  permohonan_pkpu:      "PKP",
  permohonan_pailit:    "PAI",
  jawaban_pkpu:         "JPK",
  rencana_perdamaian:   "RPD",
  kesimpulan_pkpu:      "KPK",
  surat_tuntutan:       "STT",
  statement_of_defense: "SOD",
  reply_arb:            "RPA",
  rejoinder:            "RJD",
  closing_submission:   "CSS",
};

export function generateRef(docTypeId: string): string {
  const code = DOC_TYPE_CODES[docTypeId] || "DOC";
  const rand = Math.floor(Math.random() * 900) + 100;
  const year = new Date().getFullYear();
  return `SLN/${code}/${rand}/${year}`;
}

// ─── Backward-compat shims ────────────────────────────────────────────────────

/** @deprecated Use resolveForumLabel instead */
export function findPracticeArea(id: string): { id: string; label: string } | undefined {
  const found = CLAIM_TYPES.find((f) => f.id === id);
  return found ? { id: found.id, label: found.label } : undefined;
}

/** @deprecated Use CLAIM_TYPES + FORUM_DOC_TYPES directly */
export interface PracticeAreaConfig {
  id: string;
  label: string;
  docTypes: DocTypeConfig[];
}

export const PRACTICE_AREAS: PracticeAreaConfig[] = CLAIM_TYPES.map((f) => ({
  id: f.id,
  label: f.label,
  docTypes: FORUM_DOC_TYPES[f.id] ?? [],
}));
