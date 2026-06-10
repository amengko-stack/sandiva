import { createHash } from "crypto";
import { readBlobText, writeBlobText } from "./blob";
import type { DocCategory } from "@/types";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ExtractionMetadata {
  filename: string;
  category: DocCategory;
  extractionMethod: string;
  characterCount: number;
  extractedAt: string;       // ISO
  sharePointPath: string;
  fileModifiedAt: string;    // SharePoint lastModifiedDateTime, ISO
}

export interface CachedExtraction {
  content: string;
  metadata: ExtractionMetadata;
}

export function cacheKey(sharePointFileUrl: string): string {
  const hash = createHash("sha256").update(sharePointFileUrl).digest("hex");
  return `cache/${hash}.json`;
}

// Valid only when the SharePoint file hasn't changed since extraction, the
// entry is under 7 days old, and the category (extraction depth) matches.
export async function readExtractionCache(
  sharePointFileUrl: string,
  currentModifiedAt: string | null,
  category: DocCategory
): Promise<CachedExtraction | null> {
  const raw = await readBlobText(cacheKey(sharePointFileUrl));
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as CachedExtraction;
    if (!cached.content || !cached.metadata) return null;
    if (!currentModifiedAt || cached.metadata.fileModifiedAt !== currentModifiedAt) return null;
    if (Date.now() - new Date(cached.metadata.extractedAt).getTime() > CACHE_TTL_MS) return null;
    if (cached.metadata.category !== category) return null;
    return cached;
  } catch {
    return null;
  }
}

export async function writeExtractionCache(
  sharePointFileUrl: string,
  entry: CachedExtraction
): Promise<void> {
  try {
    await writeBlobText(cacheKey(sharePointFileUrl), JSON.stringify(entry));
  } catch {
    // cache write failures must never break extraction
  }
}
