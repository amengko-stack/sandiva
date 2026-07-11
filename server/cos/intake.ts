// Client-intake legal analysis: builds an initial matter view from an intake
// description (practice area, key issues, conflict flags, recommended actions).
// LLM-backed when ANTHROPIC_API_KEY is set, deterministic keyword engine otherwise.
import Anthropic from "@anthropic-ai/sdk";
import type { CosMatter, CosUrgency } from "@shared/schema";
import { splitSentences } from "./text-utils";
import { llmAvailable } from "./triage";

export interface IntakeInput {
  client_name: string;
  contact_email?: string | null;
  matter_description: string;
}

export interface IntakeAnalysis {
  practice_area: string;
  summary: string;
  key_issues: string[];
  conflict_flags: string[];
  urgency: CosUrgency;
  recommended_actions: string[];
  estimated_complexity: "low" | "medium" | "high";
}

const PRACTICE_AREAS: Array<{ area: string; patterns: RegExp[] }> = [
  { area: "employment", patterns: [/\b(fired|terminat\w+|discriminat\w+|harass\w+|wrongful termination|wage|overtime|severance|non.?compete|retaliat\w+|hostile work)\b/i] },
  { area: "intellectual_property", patterns: [/\b(trademark|patent|copyright|trade secret|infring\w+|licensing)\b/i] },
  { area: "real_estate", patterns: [/\b(lease|landlord|tenant|evict\w+|zoning|easement|property purchase|title dispute)\b/i] },
  { area: "corporate", patterns: [/\b(merger|acquisition|shareholder|incorporat\w+|equity|board of directors|bylaws|due diligence|stock purchase)\b/i] },
  { area: "family", patterns: [/\b(divorce|custody|alimony|prenup\w*|child support)\b/i] },
  { area: "estate", patterns: [/\b(will|trust|probate|estate plan\w*|inheritance|executor)\b/i] },
  { area: "contract", patterns: [/\b(contract|breach|agreement|vendor|supplier|invoice|payment dispute|terms|non.?payment)\b/i] },
  { area: "litigation", patterns: [/\b(lawsuit|sued?|suing|complaint|damages|court|plaintiff|defendant|dispute)\b/i] },
];

const ISSUE_KEYWORDS = /\b(breach|terminat\w+|discriminat\w+|harass\w+|infring\w+|damages|owed|refus\w+|fail\w+|dispute|violat\w+|threat\w+|deadline|statute of limitations|non.?payment|injunction|sued?|fired)\b/i;

const HIGH_URGENCY = /\b(statute of limitations|deadline|court date|hearing|tomorrow|this week|next week|tro|injunction|restraining order|immediate\w*)\b/i;
const COMPLEXITY_HIGH = /\b(class action|multi.?state|federal|international|criminal referral|regulatory investigation|multiple parties|cross.?border)\b/i;

export function detectPracticeArea(description: string): string {
  let best = { area: "general", hits: 0 };
  for (const { area, patterns } of PRACTICE_AREAS) {
    const hits = patterns.reduce((n, p) => n + (description.match(new RegExp(p.source, "gi"))?.length || 0), 0);
    if (hits > best.hits) best = { area, hits };
  }
  return best.area;
}

/** Flag conflicts: intake client or description mentions an existing matter's client or adverse party. */
export function findConflicts(input: IntakeInput, existingMatters: CosMatter[]): string[] {
  const flags: string[] = [];
  const desc = input.matter_description.toLowerCase();
  const client = input.client_name.toLowerCase();
  for (const m of existingMatters) {
    const names: Array<[string, string]> = [
      [m.client_name, "current client"],
      ...(m.adverse_party ? ([[m.adverse_party, "adverse party"]] as Array<[string, string]>) : []),
    ];
    for (const [name, label] of names) {
      const n = name.toLowerCase();
      if (n.length < 3) continue;
      if (client.includes(n) || n.includes(client)) {
        flags.push(`Prospective client "${input.client_name}" matches ${label} "${name}" in matter "${m.matter_name}"`);
      } else if (desc.includes(n)) {
        flags.push(`Description mentions "${name}" — ${label} in matter "${m.matter_name}"`);
      }
    }
  }
  return Array.from(new Set(flags));
}

const AREA_ACTIONS: Record<string, string[]> = {
  employment: ["Request personnel file, employment agreement, and termination correspondence", "Check administrative filing deadlines (EEOC/state agency)"],
  contract: ["Obtain the full contract and all amendments", "Map breach timeline and quantify damages"],
  litigation: ["Issue litigation hold notice", "Check statute of limitations and any pending deadlines"],
  intellectual_property: ["Collect registrations, filings, and evidence of use", "Assess infringement scope and cease-and-desist posture"],
  real_estate: ["Obtain lease/deed and correspondence with counterparty", "Check notice and cure periods"],
  corporate: ["Collect governing documents (bylaws, shareholder agreements)", "Identify all interested parties for conflicts purposes"],
  family: ["Gather financial disclosures and any existing agreements", "Advise on immediate custody/support considerations"],
  estate: ["Collect existing wills, trusts, and asset inventory", "Identify beneficiaries and fiduciaries"],
  general: ["Gather all relevant documents and correspondence"],
};

export function heuristicIntakeAnalysis(input: IntakeInput, existingMatters: CosMatter[]): IntakeAnalysis {
  const desc = input.matter_description;
  const practice_area = detectPracticeArea(desc);
  const conflict_flags = findConflicts(input, existingMatters);

  const key_issues = splitSentences(desc)
    .filter(s => ISSUE_KEYWORDS.test(s) && s.length >= 15)
    .slice(0, 5);

  const urgency: CosUrgency = HIGH_URGENCY.test(desc) ? "high" : key_issues.length >= 3 ? "medium" : "low";

  const wordCount = desc.split(/\s+/).length;
  const estimated_complexity: IntakeAnalysis["estimated_complexity"] =
    COMPLEXITY_HIGH.test(desc) ? "high" : wordCount > 120 || key_issues.length >= 3 ? "medium" : "low";

  const recommended_actions = [
    conflict_flags.length
      ? "Resolve conflict check findings before any engagement"
      : "Run full conflicts check against firm database",
    ...(AREA_ACTIONS[practice_area] || AREA_ACTIONS.general),
    "Send engagement letter and fee agreement if cleared",
  ];

  const firstSentence = splitSentences(desc)[0] || desc.slice(0, 160);
  const summary = `${input.client_name}: ${practice_area.replace(/_/g, " ")} matter — ${firstSentence}`.slice(0, 300);

  return { practice_area, summary, key_issues, conflict_flags, urgency, recommended_actions, estimated_complexity };
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

async function llmIntakeAnalysis(input: IntakeInput, existingMatters: CosMatter[]): Promise<IntakeAnalysis> {
  const mattersList = existingMatters
    .map(m => `- client: ${m.client_name}; adverse party: ${m.adverse_party || "n/a"}; matter: ${m.matter_name}`)
    .join("\n");
  const prompt = `You are a senior law firm intake analyst. Analyze this prospective client intake and build an initial matter view.

Prospective client: ${input.client_name}
Matter description:
${input.matter_description.slice(0, 4000)}

Existing firm matters (for conflict checking):
${mattersList || "(none)"}

Respond with ONLY a JSON object:
{
  "practice_area": "employment|contract|litigation|intellectual_property|real_estate|corporate|family|estate|general",
  "summary": "2 sentences max",
  "key_issues": ["legal issues presented"],
  "conflict_flags": ["potential conflicts with existing matters, empty if none"],
  "urgency": "critical|high|medium|low",
  "recommended_actions": ["concrete next steps"],
  "estimated_complexity": "low|medium|high"
}`;

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 900,
    messages: [{ role: "user", content: prompt }],
  });
  const content = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in LLM intake response");
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    practice_area: parsed.practice_area || "general",
    summary: String(parsed.summary || ""),
    key_issues: Array.isArray(parsed.key_issues) ? parsed.key_issues.map(String) : [],
    conflict_flags: Array.isArray(parsed.conflict_flags) ? parsed.conflict_flags.map(String) : [],
    urgency: parsed.urgency || "medium",
    recommended_actions: Array.isArray(parsed.recommended_actions) ? parsed.recommended_actions.map(String) : [],
    estimated_complexity: parsed.estimated_complexity || "medium",
  };
}

export async function analyzeIntake(input: IntakeInput, existingMatters: CosMatter[]): Promise<IntakeAnalysis> {
  if (llmAvailable()) {
    try {
      return await llmIntakeAnalysis(input, existingMatters);
    } catch (err) {
      console.error("LLM intake analysis failed, using heuristic fallback:", err);
    }
  }
  return heuristicIntakeAnalysis(input, existingMatters);
}
