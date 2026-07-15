// Pure client-side matcher: pairs files found in an external OCR-output folder
// with the report's "perlu_ocr" entries so the recheck route knows which report
// entry each OCR result replaces. Unmatched OCR files are still returned
// (replacesName undefined) — the server appends them as new documents.

export interface OcrMatch {
  name: string;
  path: string;
  replacesName?: string;
}

// Normalize for base-name matching: strip extension, lowercase, then strip a
// trailing OCR marker ("name_ocr", "name-ocr", "name ocr", "name (OCR)").
function normalizeBase(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[\s_-]*\(\s*ocr\s*\)$/, "")
    .replace(/[\s_-]+ocr$/, "")
    .trim();
}

export function matchOcrFiles(
  ocrFiles: { name: string; path: string }[],
  perluOcrNames: string[]
): OcrMatch[] {
  // Each perlu_ocr name may be claimed by at most one OCR file.
  const claimed = new Set<string>();
  const matched: (string | undefined)[] = new Array(ocrFiles.length).fill(undefined);

  // Pass 1 — exact filename match (always outranks base-name matches,
  // regardless of the order files appear in the OCR folder listing).
  for (let i = 0; i < ocrFiles.length; i++) {
    const exact = perluOcrNames.find((n) => n === ocrFiles[i].name && !claimed.has(n));
    if (exact !== undefined) {
      matched[i] = exact;
      claimed.add(exact);
    }
  }

  // Pass 2 — case-insensitive base-name match (extension-agnostic, tolerating
  // common OCR suffixes) for OCR files still unmatched.
  for (let i = 0; i < ocrFiles.length; i++) {
    if (matched[i] !== undefined) continue;
    const base = normalizeBase(ocrFiles[i].name);
    const byBase = perluOcrNames.find((n) => !claimed.has(n) && normalizeBase(n) === base);
    if (byBase !== undefined) {
      matched[i] = byBase;
      claimed.add(byBase);
    }
  }

  return ocrFiles.map((f, i) => ({ name: f.name, path: f.path, replacesName: matched[i] }));
}
