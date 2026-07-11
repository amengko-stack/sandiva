// Shared types + small components for the Chief of Staff pages.

export type Urgency = "critical" | "high" | "medium" | "low";

export interface CosMessage {
  id: number;
  source: "email" | "teams";
  sender: string;
  sender_email: string | null;
  sender_role: string;
  channel: string | null;
  subject: string | null;
  body: string;
  received_at: string;
  is_read: number;
  is_archived: number;
  urgency: Urgency | null;
  category: string | null;
  triage_summary: string | null;
  action_items: string | null;
  suggested_deadline: string | null;
}

export interface CosReminder {
  id: number;
  title: string;
  notes: string | null;
  due_at: string;
  priority: Urgency;
  status: string;
  source_type: string | null;
  source_id: number | null;
  bucket?: "overdue" | "today" | "upcoming" | "done";
}

export interface CosIntake {
  id: number;
  client_name: string;
  contact_email: string | null;
  matter_description: string;
  source: string;
  status: string;
  created_at: string;
  analysis: string | null;
  analyzed_at: string | null;
  matter_id: number | null;
}

export interface CosMatter {
  id: number;
  client_name: string;
  matter_name: string;
  practice_area: string;
  adverse_party: string | null;
  status: string;
  opened_at: string;
}

export interface IntakeAnalysis {
  practice_area: string;
  summary: string;
  key_issues: string[];
  conflict_flags: string[];
  urgency: Urgency;
  recommended_actions: string[];
  estimated_complexity: "low" | "medium" | "high";
}

const URGENCY_STYLES: Record<Urgency, string> = {
  critical: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  low: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

export function UrgencyBadge({ urgency }: { urgency: Urgency | null }) {
  const u = urgency || "medium";
  return (
    <span data-testid={`badge-urgency-${u}`} className={`text-xs px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide ${URGENCY_STYLES[u]}`}>
      {u}
    </span>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  court_notice: "⚖️ Court",
  client_matter: "👤 Client",
  opposing_counsel: "🛡️ Opposing counsel",
  internal: "🏢 Internal",
  business_dev: "🤝 Biz dev",
  admin: "📎 Admin",
};

export function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  return (
    <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
      {CATEGORY_LABELS[category] || category}
    </span>
  );
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export function parseActionItems(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export function parseAnalysis(json: string | null): IntakeAnalysis | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as IntakeAnalysis;
  } catch {
    return null;
  }
}
