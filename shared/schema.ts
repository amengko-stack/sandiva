// Shared types (no Drizzle ORM — using sql.js directly)
export interface Group {
  id: number; name: string; description: string | null;
  color: string; created_at: string;
}
export interface UploadSession {
  id: number; group_id: number; filename: string; uploaded_at: string;
  date: string; message_count: number; status: string; raw_content: string | null;
}
export interface Summary {
  id: number; session_id: number; group_id: number; date: string;
  overview: string; key_topics: string; action_items: string;
  decisions: string; important_mentions: string; sentiment: string; created_at: string;
}
export interface Participant {
  id: number; session_id: number; group_id: number; date: string;
  name: string; message_count: number; word_count: number; action_items_owned: number;
}
export interface TopicTrend {
  id: number; group_id: number; week_start: string; topics: string; updated_at: string;
}
export interface ReportConfig {
  id: number; channel: string; destination: string;
  frequency: string; enabled: number; last_sent: string | null;
}

// --- Chief of Staff module ---

export type CosSource = "email" | "teams";
export type CosUrgency = "critical" | "high" | "medium" | "low";
export type CosCategory =
  | "court_notice" | "client_matter" | "opposing_counsel"
  | "internal" | "business_dev" | "admin";

export interface CosMessage {
  id: number;
  source: CosSource;
  external_id: string;
  sender: string;
  sender_email: string | null;
  sender_role: string; // client | court | opposing_counsel | associate | partner | staff | vendor | other
  channel: string | null; // Teams channel/chat name
  subject: string | null;
  body: string;
  received_at: string;
  is_read: number;
  is_archived: number;
  urgency: CosUrgency | null;
  category: CosCategory | null;
  triage_summary: string | null;
  action_items: string | null; // JSON string[]
  suggested_deadline: string | null;
  triaged_at: string | null;
}

export interface CosMatter {
  id: number;
  client_name: string;
  matter_name: string;
  practice_area: string;
  adverse_party: string | null;
  status: string; // active | closed
  opened_at: string;
}

export interface CosIntake {
  id: number;
  client_name: string;
  contact_email: string | null;
  matter_description: string;
  source: string; // referral | website | email | call
  status: string; // new | analyzed | converted | declined
  created_at: string;
  analysis: string | null; // JSON IntakeAnalysis
  analyzed_at: string | null;
  matter_id: number | null;
}

export interface CosReminder {
  id: number;
  title: string;
  notes: string | null;
  due_at: string;
  priority: CosUrgency;
  status: string; // open | done | overdue
  source_type: string | null; // message | intake | manual
  source_id: number | null;
  created_at: string;
  completed_at: string | null;
}
