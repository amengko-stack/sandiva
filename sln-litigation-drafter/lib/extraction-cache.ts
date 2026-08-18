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
  /**
   * How much of the document was read. Optional so entries written before this
   * field re-extract once, which is the safe direction.
   *
   * The cache already compared the category, and the caps are derived from it — so
   * raising a cap changed nothing a cached entry could notice, and a document
   * already extracted at the old limit would have been served truncated forever.
   * This is the third cache in one day whose key described the request rather than
   * the result; the rule that keeps coming back is that a fix which does not alter
   * the key does not exist for work already done.
   */
  charCap?: number;
}

export interface CachedExtraction {
  content: string;
  metadata: ExtractionMetadata;
}

export function cacheKey(sharePointFileUrl: string): string {
  const hash = createHash("sha256").update(sharePointFileUrl).digest("hex");
  return `cache/${hash}.json`;
}

// Valid only when the SharePoint file hasn't changed since extraction, the entry is
// under 7 days old, the category matches, and it was read to at least the depth this
// run would read it to.
export async function readExtractionCache(
  sharePointFileUrl: string,
  currentModifiedAt: string | null,
  category: DocCategory,
  charCap?: number
): Promise<CachedExtraction | null> {
  const raw = await readBlobText(cacheKey(sharePointFileUrl));
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as CachedExtraction;
    if (!cached.content || !cached.metadata) return null;
    if (!currentModifiedAt || cached.metadata.fileModifiedAt !== currentModifiedAt) return null;
    if (Date.now() - new Date(cached.metadata.extractedAt).getTime() > CACHE_TTL_MS) return null;
    if (cached.metadata.category !== category) return null;
    // Read less deeply than this run would. Re-extract rather than serve a document
    // that was cut at a limit no longer in force.
    if (charCap !== undefined && (cached.metadata.charCap ?? 0) < charCap) return null;
    return cached;
  } catch (e) {
    console.error("[cache] cached entry parse failed, treating as miss:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function writeExtractionCache(
  sharePointFileUrl: string,
  entry: CachedExtraction
): Promise<void> {
  try {
    await writeBlobText(cacheKey(sharePointFileUrl), JSON.stringify(entry));
  } catch (e) {
    // cache write failures must never break extraction
    console.error("[cache] cache write failed (extraction continues):", e instanceof Error ? e.message : e);
  }
}
