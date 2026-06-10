import type { ExtractionMetadata } from "@/lib/extraction-cache";

// Per-document block written to the combined Blob; the metadata header travels
// to Stage 3 so analysis knows what was fully vs partially extracted.
export function formatDocBlock(meta: ExtractionMetadata, content: string): string {
  return (
    `=== ${meta.filename} ===\n` +
    `[Metadata: kategori=${meta.category}; metode=${meta.extractionMethod}; karakter=${meta.characterCount}; ` +
    `diekstrak=${meta.extractedAt}; path=${meta.sharePointPath}; dimodifikasi=${meta.fileModifiedAt}]\n` +
    `${content}\n\n`
  );
}
