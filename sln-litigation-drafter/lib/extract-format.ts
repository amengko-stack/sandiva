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

export interface DocBlock {
  fileName: string;
  category: string;
  content: string;
}

// Inverse of formatDocBlock: split the combined session text back into
// per-document blocks. A header only counts when the `[Metadata: ...]` line
// follows it directly, so `=== ... ===` strings inside document content can't
// create phantom documents.
export function splitDocBlocks(combined: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const headerRe = /^=== (.+?) ===\r?\n\[Metadata: ([^\]]*)\]\r?\n/gm;
  const matches = Array.from(combined.matchAll(headerRe));
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : combined.length;
    const catMatch = /kategori=([^;]+)/.exec(m[2]);
    blocks.push({
      fileName: m[1],
      category: catMatch ? catMatch[1].trim() : "—",
      content: combined.slice(start, end).trim(),
    });
  }
  return blocks;
}
