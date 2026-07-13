import type { DocCategory } from "@/types";

// DD extraction depth: material documents get the full KRITIS tier; the rest
// PENDUKUNG (30k chars). Nothing is REFERENSI — a data room is read, not skimmed.
const KRITIS_RE =
  /perjanjian|pks|kontrak|agreement|loan|kredit|fasilitas|akta|anggaran dasar|nib|izin|iup|sertifikat|shgb|hgb|hgu|polis|spt|pajak|fiskal|rups|sirkuler|putusan|gugatan|somasi/i;

export function preCategorize(fileName: string): DocCategory {
  return KRITIS_RE.test(fileName) ? "KRITIS" : "PENDUKUNG";
}
