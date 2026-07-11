// Message triage engine: classifies urgency + category, summarizes, extracts
// action items and deadlines. Uses Anthropic when ANTHROPIC_API_KEY is set,
// otherwise a deterministic heuristic scorer so the app works without secrets.
import Anthropic from "@anthropic-ai/sdk";
import type { CosUrgency, CosCategory } from "@shared/schema";
import { extractDeadline, extractActionItems, splitSentences, hoursBetween } from "./text-utils";

export interface TriageInput {
  source: "email" | "teams";
  sender: string;
  sender_role: string;
  channel?: string | null;
  subject?: string | null;
  body: string;
  received_at: string;
}

export interface TriageResult {
  urgency: CosUrgency;
  category: CosCategory;
  summary: string;
  action_items: string[];
  suggested_deadline: string | null;
}

const URGENCY_KEYWORDS: Array<[RegExp, number]> = [
  [/\bsubpoena\b/i, 5],
  [/\bcourt order\b/i, 5],
  [/\bstatute of limitations\b/i, 5],
  [/\b(?:temporary restraining order|tro|injunction)\b/i, 5],
  [/\bsanction/i, 4],
  [/\bhearing\b/i, 4],
  [/\bfinal notice\b/i, 4],
  [/\bmotion to (?:dismiss|compel|strike)\b/i, 4],
  [/\burgent\b/i, 3],
  [/\basap\b/i, 3],
  [/\bdeadline\b/i, 3],
  [/\bfiling\b/i, 3],
  [/\bsettlement offer\b/i, 3],
  [/\btime.?sensitive\b/i, 3],
  [/\bexpir(?:es|ing|ation)\b/i, 2],
  [/\bmotion\b/i, 2],
  [/\bdiscovery\b/i, 2],
  [/\bdeposition\b/i, 2],
  [/\bimmediately\b/i, 2],
];

const ROLE_BOOST: Record<string, number> = {
  court: 3,
  client: 2,
  opposing_counsel: 2,
  partner: 1,
  associate: 0,
  staff: 0,
  vendor: 0,
  other: 0,
};

const ADMIN_PATTERNS = /\b(newsletter|cle credit|webinar|subscription|unsubscribe|bar association event|marketing|happy hour|parking|office supplies)\b/i;
const BIZDEV_PATTERNS = /\b(prospective client|new client inquiry|referral|engagement letter|potential matter|would like to retain|seeking representation)\b/i;

export function categorize(input: TriageInput): CosCategory {
  const text = `${input.subject || ""} ${input.body}`;
  if (input.sender_role === "court") return "court_notice";
  if (input.sender_role === "opposing_counsel") return "opposing_counsel";
  if (BIZDEV_PATTERNS.test(text)) return "business_dev";
  if (ADMIN_PATTERNS.test(text)) return "admin";
  if (input.sender_role === "client") return "client_matter";
  if (["associate", "partner", "staff"].includes(input.sender_role)) return "internal";
  return "admin";
}

export function scoreUrgency(input: TriageInput, now: Date): { urgency: CosUrgency; score: number } {
  const text = `${input.subject || ""} ${input.body}`;
  let score = 0;
  for (const [pattern, weight] of URGENCY_KEYWORDS) {
    if (pattern.test(text)) score += weight;
  }
  score += ROLE_BOOST[input.sender_role] ?? 0;

  const deadline = extractDeadline(text, now);
  if (deadline) {
    const hrs = hoursBetween(now, new Date(deadline));
    if (hrs <= 48) score += 4;
    else if (hrs <= 24 * 7) score += 2;
  }

  // Admin chatter never outranks real legal work
  if (categorize(input) === "admin") score = Math.min(score, 2);

  const urgency: CosUrgency = score >= 8 ? "critical" : score >= 5 ? "high" : score >= 3 ? "medium" : "low";
  return { urgency, score };
}

export function heuristicTriage(input: TriageInput, now: Date = new Date()): TriageResult {
  const text = `${input.subject || ""} ${input.body}`;
  const category = categorize(input);
  const { urgency } = scoreUrgency(input, now);
  const action_items = extractActionItems(input.body);
  const suggested_deadline = extractDeadline(text, now);

  // Summary: subject (if any) + first meaty sentence
  const firstSentence = splitSentences(input.body).find(s => s.length > 20) || input.body.slice(0, 140);
  const from = input.source === "teams" && input.channel
    ? `${input.sender} in ${input.channel}`
    : input.sender;
  const summary = `${from}: ${input.subject ? input.subject + " — " : ""}${firstSentence}`.slice(0, 280);

  return { urgency, category, summary, action_items, suggested_deadline };
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function llmTriage(input: TriageInput, now: Date): Promise<TriageResult> {
  const prompt = `You are the chief of staff for a law firm partner. Triage this ${input.source} message.

From: ${input.sender} (role: ${input.sender_role})${input.channel ? `\nChannel: ${input.channel}` : ""}
Subject: ${input.subject || "(none)"}
Received: ${input.received_at}
Current time: ${now.toISOString()}

Body:
${input.body.slice(0, 4000)}

Respond with ONLY a JSON object:
{
  "urgency": "critical" | "high" | "medium" | "low",
  "category": "court_notice" | "client_matter" | "opposing_counsel" | "internal" | "business_dev" | "admin",
  "summary": "one sentence, max 200 chars",
  "action_items": ["specific things the partner must do"],
  "suggested_deadline": "ISO timestamp or null"
}`;

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });
  const content = response.content[0].type === "text" ? response.content[0].text : "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in LLM triage response");
  const parsed = JSON.parse(jsonMatch[0]);
  return {
    urgency: parsed.urgency || "medium",
    category: parsed.category || "internal",
    summary: String(parsed.summary || "").slice(0, 280),
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items.map(String) : [],
    suggested_deadline: parsed.suggested_deadline || null,
  };
}

export async function triageMessage(input: TriageInput, now: Date = new Date()): Promise<TriageResult> {
  if (llmAvailable()) {
    try {
      return await llmTriage(input, now);
    } catch (err) {
      console.error("LLM triage failed, using heuristic fallback:", err);
    }
  }
  return heuristicTriage(input, now);
}
