// Central model tiering — every Anthropic API call selects its model here.
export const MODELS = {
  categorization: "claude-haiku-4-5-20251001",  // Stage 2B + cache summaries
  extraction: "claude-sonnet-4-6",               // Stage 2C structured extraction
  kronologi: "claude-opus-4-8",                  // Stage 3A
  interview: "claude-sonnet-4-6",                // Stage 3B question generation
  assessment: "claude-opus-4-8",                 // Stage 3C strategic assessment
  drafting: "claude-opus-4-8",                   // Stage 4 draft generation
  critique: "claude-sonnet-4-6",                 // Stage 4 critique pass
  patterns: "claude-haiku-4-5-20251001",         // memory pattern extraction
  // --- Due Diligence workflow ---
  ddClassification: "claude-haiku-4-5-20251001", // DD Stage 3 doc classification
  ddTailoring: "claude-sonnet-4-6",              // DD Stage 3 checklist tailoring
  ddExtraction: "claude-sonnet-4-6",             // DD Stage 4 key-terms tables
  ddRedFlag: "claude-sonnet-4-6",                // DD Stage 5 red-flag analysis
  ddVerify: "claude-sonnet-4-6",                 // DD Stage 5 adversarial verify
  ddConsolidation: "claude-opus-4-8",            // DD Stage 5 cross-entity pass
} as const;
