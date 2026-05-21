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
