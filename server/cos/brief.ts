// Daily Brief generator: the 3-5 things that need the partner's attention now,
// plus stats and upcoming deadlines — aggregated from triaged messages,
// reminders, and pending intakes.
import * as storage from "../storage";
import type { CosUrgency } from "@shared/schema";
import { sweepOverdue } from "./reminders";

export interface BriefItem {
  type: "message" | "reminder" | "intake";
  ref_id: number;
  title: string;
  detail: string;
  urgency: CosUrgency;
  due_at: string | null;
  source: string; // email | teams | reminder | intake
}

export interface DailyBrief {
  generated_at: string;
  date_label: string;
  attention_items: BriefItem[];
  upcoming_deadlines: Array<{ label: string; due_at: string; source: string }>;
  stats: {
    unread_messages: number;
    critical_or_high: number;
    overdue_reminders: number;
    due_today: number;
    pending_intakes: number;
  };
}

const URGENCY_RANK: Record<CosUrgency, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function generateBrief(now: Date = new Date()): DailyBrief {
  sweepOverdue(now);

  const messages = storage.cosGetMessages({});
  const reminders = storage.cosGetReminders();
  const intakes = storage.cosGetIntakes();

  const items: BriefItem[] = [];

  // Overdue reminders escalate to critical
  for (const r of reminders.filter(r => r.status === "overdue")) {
    items.push({
      type: "reminder", ref_id: r.id,
      title: `OVERDUE: ${r.title}`,
      detail: r.notes || "This reminder is past due.",
      urgency: "critical", due_at: r.due_at, source: "reminder",
    });
  }

  // Unread messages by triaged urgency (critical/high only for attention list)
  for (const m of messages.filter(m => !m.is_read)) {
    const urgency = (m.urgency || "medium") as CosUrgency;
    if (urgency !== "critical" && urgency !== "high") continue;
    items.push({
      type: "message", ref_id: m.id,
      title: m.subject || `${m.sender}${m.channel ? ` in ${m.channel}` : ""}`,
      detail: m.triage_summary || m.body.slice(0, 160),
      urgency, due_at: m.suggested_deadline, source: m.source,
    });
  }

  // Reminders due today
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  for (const r of reminders.filter(r => r.status === "open")) {
    const due = new Date(r.due_at);
    if (due.getTime() >= now.getTime() && due.getTime() <= endOfToday.getTime()) {
      items.push({
        type: "reminder", ref_id: r.id,
        title: r.title,
        detail: r.notes || "Due today.",
        urgency: (r.priority as CosUrgency) || "medium", due_at: r.due_at, source: "reminder",
      });
    }
  }

  // Pending intakes awaiting review
  for (const i of intakes.filter(i => i.status === "new" || i.status === "analyzed")) {
    let urgency: CosUrgency = "medium";
    let detail = "New client intake awaiting analysis.";
    if (i.analysis) {
      try {
        const a = JSON.parse(i.analysis);
        urgency = a.urgency || "medium";
        detail = a.conflict_flags?.length
          ? `Conflict check flagged ${a.conflict_flags.length} issue(s) — review before engaging.`
          : a.summary || detail;
      } catch { /* keep defaults */ }
    }
    items.push({
      type: "intake", ref_id: i.id,
      title: `Intake: ${i.client_name}`,
      detail, urgency, due_at: null, source: "intake",
    });
  }

  items.sort((a, b) => {
    const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
    if (byUrgency !== 0) return byUrgency;
    const aDue = a.due_at ? new Date(a.due_at).getTime() : Infinity;
    const bDue = b.due_at ? new Date(b.due_at).getTime() : Infinity;
    return aDue - bDue;
  });

  // Upcoming deadlines within 10 days: message deadlines + open reminders
  const horizon = now.getTime() + 10 * 24 * 3600000;
  const deadlines: DailyBrief["upcoming_deadlines"] = [];
  for (const m of messages) {
    if (m.suggested_deadline) {
      const t = new Date(m.suggested_deadline).getTime();
      if (t >= now.getTime() && t <= horizon) {
        deadlines.push({ label: m.subject || m.triage_summary || m.sender, due_at: m.suggested_deadline, source: m.source });
      }
    }
  }
  for (const r of reminders.filter(r => r.status === "open" || r.status === "overdue")) {
    const t = new Date(r.due_at).getTime();
    if (t <= horizon) deadlines.push({ label: r.title, due_at: r.due_at, source: "reminder" });
  }
  deadlines.sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());

  const unread = messages.filter(m => !m.is_read);
  return {
    generated_at: now.toISOString(),
    date_label: now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    attention_items: items.slice(0, 5),
    upcoming_deadlines: deadlines.slice(0, 8),
    stats: {
      unread_messages: unread.length,
      critical_or_high: unread.filter(m => m.urgency === "critical" || m.urgency === "high").length,
      overdue_reminders: reminders.filter(r => r.status === "overdue").length,
      due_today: reminders.filter(r => r.status === "open" && new Date(r.due_at) >= now && new Date(r.due_at) <= endOfDay(now)).length,
      pending_intakes: intakes.filter(i => i.status === "new" || i.status === "analyzed").length,
    },
  };
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}
