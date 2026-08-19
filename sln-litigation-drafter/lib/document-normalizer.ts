import {
  charCapFor,
  extractWithTier,
  getFileLastModified,
} from "@/lib/sharepoint";
import {
  readExtractionCache,
  writeExtractionCache,
} from "@/lib/extraction-cache";
import { formatDocBlock } from "@/lib/extract-format";

/**
 * Compatibility seam for the existing document-intelligence pipeline.
 *
 * This facade deliberately delegates to the current implementation without
 * translating inputs, outputs, errors, cache records, or provenance. Future
 * normalizers can be evaluated behind this contract without changing the
 * specialist routes or making derived text authoritative over the source file.
 */
export interface DocumentNormalizer {
  charCapFor: typeof charCapFor;
  extractWithTier: typeof extractWithTier;
  getFileLastModified: typeof getFileLastModified;
  readExtractionCache: typeof readExtractionCache;
  writeExtractionCache: typeof writeExtractionCache;
  formatDocBlock: typeof formatDocBlock;
}

export const documentNormalizer: DocumentNormalizer = Object.freeze({
  charCapFor,
  extractWithTier,
  getFileLastModified,
  readExtractionCache,
  writeExtractionCache,
  formatDocBlock,
});
