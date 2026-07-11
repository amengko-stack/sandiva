// Shared date/text extraction helpers for the COS heuristic engines.
// All functions are deterministic given an explicit `now` so they are unit-testable.

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function atNoon(d: Date): Date {
  const out = new Date(d);
  out.setHours(12, 0, 0, 0);
  return out;
}

/** Extract the earliest concrete future-ish date mentioned in text. Returns ISO string or null. */
export function extractDeadline(text: string, now: Date): string | null {
  const lower = text.toLowerCase();
  const candidates: Date[] = [];

  // Month-name dates: "July 14", "Jul 14, 2026"
  const monthRe = new RegExp(
    `\\b(${MONTHS.join("|")}|${MONTHS.map(m => m.slice(0, 3)).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = monthRe.exec(lower))) {
    const monIdx = MONTHS.findIndex(mm => mm.startsWith(m![1].slice(0, 3)));
    const day = parseInt(m[2], 10);
    if (monIdx < 0 || day < 1 || day > 31) continue;
    let year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    let d = atNoon(new Date(year, monIdx, day));
    if (!m[3] && d.getTime() < now.getTime() - 24 * 3600 * 1000) {
      d = atNoon(new Date(year + 1, monIdx, day)); // no year given and in the past → assume next year
    }
    candidates.push(d);
  }

  // Numeric dates: M/D/YYYY or M/D (US order)
  const numRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  while ((m = numRe.exec(lower))) {
    const mon = parseInt(m[1], 10), day = parseInt(m[2], 10);
    if (mon < 1 || mon > 12 || day < 1 || day > 31) continue;
    let year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;
    let d = atNoon(new Date(year, mon - 1, day));
    if (!m[3] && d.getTime() < now.getTime() - 24 * 3600 * 1000) {
      d = atNoon(new Date(year + 1, mon - 1, day));
    }
    candidates.push(d);
  }

  // ISO dates: 2026-07-14
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = isoRe.exec(lower))) {
    const d = atNoon(new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
    if (!isNaN(d.getTime())) candidates.push(d);
  }

  // Relative expressions
  if (/\b(today|eod|end of (the )?day|cob|close of business)\b/.test(lower)) {
    const d = new Date(now); d.setHours(17, 0, 0, 0);
    candidates.push(d);
  }
  if (/\btomorrow\b/.test(lower)) {
    const d = atNoon(new Date(now)); d.setDate(d.getDate() + 1);
    candidates.push(d);
  }
  if (/\bend of (the )?week\b/.test(lower)) {
    const d = atNoon(new Date(now)); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
    candidates.push(d);
  }
  const wdRe = new RegExp(`\\b(?:by|on|before|due|this|next)\\s+(${WEEKDAYS.join("|")})\\b`, "g");
  while ((m = wdRe.exec(lower))) {
    const target = WEEKDAYS.indexOf(m[1]);
    const d = atNoon(new Date(now));
    const delta = (target - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + delta);
    candidates.push(d);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.getTime() - b.getTime());
  // Prefer the earliest date that is not more than a day in the past
  const future = candidates.find(d => d.getTime() >= now.getTime() - 24 * 3600 * 1000);
  return (future || candidates[candidates.length - 1]).toISOString();
}

/** Split text into sentences (crude but deterministic). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

const ACTION_PATTERNS: RegExp[] = [
  /\bplease\b/i,
  /\bkindly\b/i,
  /\bneeds?\s+(?:you\s+)?to\b/i,
  /\bcan\s+you\b/i,
  /\bcould\s+you\b/i,
  /\bwould\s+you\b/i,
  /\bmust\s+(?:be\s+)?(?:file|submit|respond|serve|sign|review|approve)/i,
  /\b(?:respond|reply|confirm|review|sign|approve|file|submit|send|provide|advise)\s+(?:by|before|no later than)\b/i,
  /\baction\s+required\b/i,
  /\bawaiting\s+your\b/i,
  /\blet\s+me\s+know\b/i,
];

/** Extract actionable sentences from a message body. */
export function extractActionItems(text: string, max = 4): string[] {
  const items: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.length < 8 || sentence.length > 300) continue;
    if (ACTION_PATTERNS.some(p => p.test(sentence))) {
      items.push(sentence);
      if (items.length >= max) break;
    }
  }
  return items;
}

/** Hours between two ISO timestamps / dates (b - a). */
export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3600000;
}
