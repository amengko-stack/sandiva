import type { ExtractReport, ExtractReportFile } from "@/types";

// Merge a re-run's report into the prior report: entries for the SAME filename
// are REPLACED by the new run's entry (retry semantics); counters are
// recomputed from the merged files array so nothing double-counts.
export function mergeExtractReports(
  existing: ExtractReport,
  current: ExtractReport
): ExtractReport {
  const currentByName = new Map<string, ExtractReportFile>();
  for (const f of current.files) currentByName.set(f.name, f);

  // Existing order preserved; same-name entries swapped for the new run's.
  const replacedNames = new Set<string>();
  const files: ExtractReportFile[] = existing.files.map((f) => {
    const replacement = currentByName.get(f.name);
    if (replacement) {
      replacedNames.add(f.name);
      return replacement;
    }
    return f;
  });
  // Brand-new names appended in the current run's order.
  for (const f of current.files) {
    if (!replacedNames.has(f.name)) files.push(f);
  }

  // Counters recomputed from the merged array — never added across runs.
  let processed = 0;
  let skipped = 0;
  let ocrRequired = 0;
  let totalChars = 0;
  for (const f of files) {
    if (f.status === "selesai") processed++;
    else if (f.status === "gagal") skipped++;
    else if (f.status === "perlu_ocr") ocrRequired++;
    totalChars += f.charCount ?? 0;
  }

  return {
    // Metadata (sessionId, timestamp, ref, docTypeId, ...) from the new run.
    ...current,
    files,
    processed,
    skipped,
    ocrRequired,
    totalChars,
    // Informational only — additive across runs is fine.
    cacheHits: (existing.cacheHits ?? 0) + (current.cacheHits ?? 0),
  };
}
