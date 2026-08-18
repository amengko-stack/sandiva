import type { DocCategory } from "@/types";

// DD extraction depth: material documents get the full KRITIS tier; the rest
// PENDUKUNG. Nothing is REFERENSI — a data room is read, not skimmed.
//
// Financial-statement terms were missing, and the omission was expensive. On a live
// dissolution the six audited accounts were named "2021 FS PT SBI Bangun
// Nusantara_Dec. 31, 2021.pdf" and the like, matched nothing here, fell to the lower
// tier and were cut — while the tax return, which happens to contain "spt", came
// through whole. The notes to a financial statement sit at the end: contingent
// liabilities, related-party detail, going concern. A solvency analysis was written
// on statements missing exactly that, and nothing said so.
const KRITIS_RE =
  /perjanjian|pks|kontrak|agreement|loan|kredit|fasilitas|akta|anggaran dasar|nib|izin|iup|sertifikat|shgb|hgb|hgu|polis|spt|pajak|fiskal|rups|sirkuler|putusan|gugatan|somasi|laporan keuangan|financial statement|\bfs\b|\blk\b|audit|auditan|neraca|laba rugi|balance sheet|31 desember|31 december|dec\.? 31/i;

export function preCategorize(fileName: string): DocCategory {
  return KRITIS_RE.test(fileName) ? "KRITIS" : "PENDUKUNG";
}
