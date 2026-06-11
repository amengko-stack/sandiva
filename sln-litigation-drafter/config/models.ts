// Central model tiering — every Anthropic API call selects its model here.
export const MODELS = {
  categorization: "claude-haiku-4-5-20251001",  // Stage 2B + cache summaries
  extraction: "claude-sonnet-4-6",               // Stage 2C structured extraction
  kronologi: "claude-sonnet-4-6",                // Stage 3A
  interview: "claude-sonnet-4-6",                // Stage 3B question generation
  assessment: "claude-opus-4-8",                 // Stage 3C strategic assessment
  drafting: "claude-opus-4-8",                   // Stage 4 draft generation
  critique: "claude-sonnet-4-6",                 // Stage 4 critique pass
  patterns: "claude-haiku-4-5-20251001",         // memory pattern extraction
} as const;
