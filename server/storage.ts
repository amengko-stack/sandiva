import initSqlJs, { Database } from "sql.js";
import fs from "fs";
import path from "path";

const DB_PATH = path.resolve(process.env.DATA_DB_PATH || "data.db");

let db: Database;

export async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL DEFAULT '#01696f',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      date TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'processing',
      raw_content TEXT
    );
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      overview TEXT NOT NULL,
      key_topics TEXT NOT NULL,
      action_items TEXT NOT NULL,
      decisions TEXT NOT NULL,
      important_mentions TEXT NOT NULL,
      sentiment TEXT NOT NULL DEFAULT 'neutral',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 0,
      action_items_owned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS topic_trends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      week_start TEXT NOT NULL,
      topics TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS report_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL DEFAULT 'email',
      destination TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'daily',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_sent TEXT
    );
    CREATE TABLE IF NOT EXISTS cos_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      sender TEXT NOT NULL,
      sender_email TEXT,
      sender_role TEXT NOT NULL DEFAULT 'other',
      channel TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      urgency TEXT,
      category TEXT,
      triage_summary TEXT,
      action_items TEXT,
      suggested_deadline TEXT,
      triaged_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cos_matters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      matter_name TEXT NOT NULL,
      practice_area TEXT NOT NULL DEFAULT 'general',
      adverse_party TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      opened_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cos_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      contact_email TEXT,
      matter_description TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'email',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL,
      analysis TEXT,
      analyzed_at TEXT,
      matter_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS cos_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      notes TEXT,
      due_at TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      source_type TEXT,
      source_id INTEGER,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function query<T = any>(sql: string, params: any[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

// db.export() inside saveDb() resets sqlite's last_insert_rowid() to 0,
// so the rowid must be captured before saving.
let _lastInsertId = 0;

function run(sql: string, params: any[] = []) {
  db.run(sql, params);
  const res = db.exec("SELECT last_insert_rowid() as id");
  _lastInsertId = res.length > 0 && res[0].values.length > 0 ? (res[0].values[0][0] as number) : 0;
  saveDb();
}

function lastInsertId(): number {
  return _lastInsertId;
}

// --- Groups ---
export function getGroups() {
  return query("SELECT * FROM groups ORDER BY name");
}
export function getGroup(id: number) {
  return query("SELECT * FROM groups WHERE id = ?", [id])[0] || null;
}
export function createGroup(data: { name: string; description?: string; color?: string }) {
  run("INSERT INTO groups (name, description, color, created_at) VALUES (?, ?, ?, ?)", [
    data.name, data.description || null, data.color || "#01696f", new Date().toISOString()
  ]);
  const id = lastInsertId();
  // Fallback: find by name if id lookup fails
  const byId = getGroup(id);
  if (byId) return byId;
  const rows = query("SELECT * FROM groups WHERE name = ? ORDER BY id DESC LIMIT 1", [data.name]);
  return rows[0] || null;
}
export function updateGroup(id: number, data: Partial<{ name: string; description: string; color: string }>) {
  const fields = Object.keys(data).map(k => `${toSnake(k)} = ?`).join(", ");
  if (!fields) return getGroup(id);
  run(`UPDATE groups SET ${fields} WHERE id = ?`, [...Object.values(data), id]);
  return getGroup(id);
}
export function deleteGroup(id: number) {
  run("DELETE FROM groups WHERE id = ?", [id]);
}

// --- Upload Sessions ---
export function getUploadSessions(groupId?: number) {
  if (groupId) return query("SELECT * FROM upload_sessions WHERE group_id = ? ORDER BY date DESC", [groupId]);
  return query("SELECT * FROM upload_sessions ORDER BY date DESC");
}
export function getUploadSession(id: number) {
  return query("SELECT * FROM upload_sessions WHERE id = ?", [id])[0] || null;
}
export function createUploadSession(data: any) {
  run("INSERT INTO upload_sessions (group_id, filename, uploaded_at, date, message_count, status, raw_content) VALUES (?,?,?,?,?,?,?)", [
    data.groupId, data.filename, data.uploadedAt, data.date, data.messageCount, data.status, data.rawContent || null
  ]);
  const id = lastInsertId();
  const row = getUploadSession(id);
  if (row) return row;
  const rows = query("SELECT * FROM upload_sessions WHERE group_id = ? ORDER BY id DESC LIMIT 1", [data.groupId]);
  return rows[0] || { id, ...data };
}
export function updateUploadSession(id: number, data: any) {
  const map: any = { status: data.status, message_count: data.messageCount };
  const entries = Object.entries(map).filter(([, v]) => v !== undefined);
  if (!entries.length) return getUploadSession(id);
  const fields = entries.map(([k]) => `${k} = ?`).join(", ");
  run(`UPDATE upload_sessions SET ${fields} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
  return getUploadSession(id);
}

// --- Summaries ---
export function getSummaries(groupId?: number, limit = 50) {
  if (groupId) return query("SELECT * FROM summaries WHERE group_id = ? ORDER BY date DESC LIMIT ?", [groupId, limit]);
  return query("SELECT * FROM summaries ORDER BY date DESC LIMIT ?", [limit]);
}
export function getSummaryBySession(sessionId: number) {
  return query("SELECT * FROM summaries WHERE session_id = ?", [sessionId])[0] || null;
}
export function createSummary(data: any) {
  run("INSERT INTO summaries (session_id, group_id, date, overview, key_topics, action_items, decisions, important_mentions, sentiment, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [
    data.sessionId, data.groupId, data.date, data.overview,
    data.keyTopics, data.actionItems, data.decisions, data.importantMentions,
    data.sentiment, data.createdAt
  ]);
  return query("SELECT * FROM summaries WHERE id = ?", [lastInsertId()])[0];
}

// --- Participants ---
export function getParticipants(sessionId: number) {
  return query("SELECT * FROM participants WHERE session_id = ? ORDER BY message_count DESC", [sessionId]);
}
export function getParticipantsByGroup(groupId: number) {
  return query("SELECT * FROM participants WHERE group_id = ?", [groupId]);
}
export function upsertParticipants(data: any[]) {
  for (const p of data) {
    run("INSERT INTO participants (session_id, group_id, date, name, message_count, word_count, action_items_owned) VALUES (?,?,?,?,?,?,?)", [
      p.sessionId, p.groupId, p.date, p.name, p.messageCount, p.wordCount, p.actionItemsOwned
    ]);
  }
}

// --- Topic Trends ---
export function getTopicTrends(groupId: number) {
  return query("SELECT * FROM topic_trends WHERE group_id = ? ORDER BY week_start DESC LIMIT 8", [groupId]);
}
export function upsertTopicTrend(data: any) {
  const existing = query("SELECT * FROM topic_trends WHERE group_id = ? AND week_start = ?", [data.groupId, data.weekStart])[0];
  if (existing) {
    run("UPDATE topic_trends SET topics = ?, updated_at = ? WHERE id = ?", [data.topics, data.updatedAt, existing.id]);
    return query("SELECT * FROM topic_trends WHERE id = ?", [existing.id])[0];
  }
  run("INSERT INTO topic_trends (group_id, week_start, topics, updated_at) VALUES (?,?,?,?)", [
    data.groupId, data.weekStart, data.topics, data.updatedAt
  ]);
  return query("SELECT * FROM topic_trends WHERE id = ?", [lastInsertId()])[0];
}

// --- Report Configs ---
export function getReportConfigs() {
  return query("SELECT * FROM report_configs");
}
export function createReportConfig(data: any) {
  run("INSERT INTO report_configs (channel, destination, frequency, enabled) VALUES (?,?,?,?)", [
    data.channel, data.destination, data.frequency, 1
  ]);
  return query("SELECT * FROM report_configs WHERE id = ?", [lastInsertId()])[0];
}
export function updateReportConfig(id: number, data: any) {
  const allowed = ["channel", "destination", "frequency", "enabled", "last_sent"];
  const map: any = {
    channel: data.channel, destination: data.destination,
    frequency: data.frequency, enabled: data.enabled, last_sent: data.lastSent
  };
  const entries = Object.entries(map).filter(([k, v]) => v !== undefined && allowed.includes(k));
  if (!entries.length) return query("SELECT * FROM report_configs WHERE id = ?", [id])[0];
  const fields = entries.map(([k]) => `${k} = ?`).join(", ");
  run(`UPDATE report_configs SET ${fields} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
  return query("SELECT * FROM report_configs WHERE id = ?", [id])[0];
}
export function deleteReportConfig(id: number) {
  run("DELETE FROM report_configs WHERE id = ?", [id]);
}

function toSnake(s: string) {
  return s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
}

// =====================================================================
// Chief of Staff (COS) module
// =====================================================================
import type { CosMessage, CosMatter, CosIntake, CosReminder } from "@shared/schema";

// --- COS Messages ---
export function cosGetMessages(opts: { source?: string; archived?: boolean } = {}): CosMessage[] {
  const conds: string[] = [];
  const params: any[] = [];
  if (opts.source) { conds.push("source = ?"); params.push(opts.source); }
  conds.push("is_archived = ?");
  params.push(opts.archived ? 1 : 0);
  return query<CosMessage>(
    `SELECT * FROM cos_messages WHERE ${conds.join(" AND ")} ORDER BY received_at DESC`,
    params
  );
}
export function cosGetMessage(id: number): CosMessage | null {
  return query<CosMessage>("SELECT * FROM cos_messages WHERE id = ?", [id])[0] || null;
}
export function cosMessageExists(externalId: string): boolean {
  return query("SELECT id FROM cos_messages WHERE external_id = ?", [externalId]).length > 0;
}
// Batch insert: one file save for the whole sync instead of per row
export function cosInsertMessages(msgs: Array<Omit<CosMessage, "id">>): number {
  let inserted = 0;
  for (const m of msgs) {
    if (cosMessageExists(m.external_id)) continue;
    db.run(
      `INSERT INTO cos_messages (source, external_id, sender, sender_email, sender_role, channel, subject, body, received_at,
        is_read, is_archived, urgency, category, triage_summary, action_items, suggested_deadline, triaged_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [m.source, m.external_id, m.sender, m.sender_email, m.sender_role, m.channel, m.subject, m.body, m.received_at,
       m.is_read, m.is_archived, m.urgency, m.category, m.triage_summary, m.action_items, m.suggested_deadline, m.triaged_at]
    );
    inserted++;
  }
  if (inserted > 0) saveDb();
  return inserted;
}
export function cosUpdateMessage(id: number, data: Partial<Pick<CosMessage,
  "is_read" | "is_archived" | "urgency" | "category" | "triage_summary" | "action_items" | "suggested_deadline" | "triaged_at">>): CosMessage | null {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (entries.length) {
    const fields = entries.map(([k]) => `${k} = ?`).join(", ");
    run(`UPDATE cos_messages SET ${fields} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
  }
  return cosGetMessage(id);
}

// --- COS Matters ---
export function cosGetMatters(): CosMatter[] {
  return query<CosMatter>("SELECT * FROM cos_matters ORDER BY opened_at DESC");
}
export function cosCreateMatter(data: { client_name: string; matter_name: string; practice_area?: string; adverse_party?: string | null }): CosMatter {
  run("INSERT INTO cos_matters (client_name, matter_name, practice_area, adverse_party, status, opened_at) VALUES (?,?,?,?,?,?)", [
    data.client_name, data.matter_name, data.practice_area || "general", data.adverse_party || null, "active", new Date().toISOString()
  ]);
  return query<CosMatter>("SELECT * FROM cos_matters WHERE id = ?", [lastInsertId()])[0];
}

// --- COS Intakes ---
export function cosGetIntakes(): CosIntake[] {
  return query<CosIntake>("SELECT * FROM cos_intakes ORDER BY created_at DESC");
}
export function cosGetIntake(id: number): CosIntake | null {
  return query<CosIntake>("SELECT * FROM cos_intakes WHERE id = ?", [id])[0] || null;
}
export function cosCreateIntake(data: { client_name: string; contact_email?: string | null; matter_description: string; source?: string }): CosIntake {
  run("INSERT INTO cos_intakes (client_name, contact_email, matter_description, source, status, created_at) VALUES (?,?,?,?,?,?)", [
    data.client_name, data.contact_email || null, data.matter_description, data.source || "email", "new", new Date().toISOString()
  ]);
  return query<CosIntake>("SELECT * FROM cos_intakes WHERE id = ?", [lastInsertId()])[0];
}
export function cosUpdateIntake(id: number, data: Partial<Pick<CosIntake, "status" | "analysis" | "analyzed_at" | "matter_id">>): CosIntake | null {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (entries.length) {
    const fields = entries.map(([k]) => `${k} = ?`).join(", ");
    run(`UPDATE cos_intakes SET ${fields} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
  }
  return cosGetIntake(id);
}

// --- COS Reminders ---
export function cosGetReminders(status?: string): CosReminder[] {
  if (status) return query<CosReminder>("SELECT * FROM cos_reminders WHERE status = ? ORDER BY due_at ASC", [status]);
  return query<CosReminder>("SELECT * FROM cos_reminders ORDER BY due_at ASC");
}
export function cosGetReminder(id: number): CosReminder | null {
  return query<CosReminder>("SELECT * FROM cos_reminders WHERE id = ?", [id])[0] || null;
}
export function cosCreateReminder(data: { title: string; notes?: string | null; due_at: string; priority?: string; source_type?: string | null; source_id?: number | null }): CosReminder {
  run("INSERT INTO cos_reminders (title, notes, due_at, priority, status, source_type, source_id, created_at) VALUES (?,?,?,?,?,?,?,?)", [
    data.title, data.notes || null, data.due_at, data.priority || "medium", "open",
    data.source_type || "manual", data.source_id ?? null, new Date().toISOString()
  ]);
  return query<CosReminder>("SELECT * FROM cos_reminders WHERE id = ?", [lastInsertId()])[0];
}
export function cosUpdateReminder(id: number, data: Partial<Pick<CosReminder, "title" | "notes" | "due_at" | "priority" | "status" | "completed_at">>): CosReminder | null {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (entries.length) {
    const fields = entries.map(([k]) => `${k} = ?`).join(", ");
    run(`UPDATE cos_reminders SET ${fields} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
  }
  return cosGetReminder(id);
}
export function cosDeleteReminder(id: number) {
  run("DELETE FROM cos_reminders WHERE id = ?", [id]);
}
// Batch status update used by the overdue sweep: single save
export function cosMarkRemindersOverdue(ids: number[]): void {
  if (!ids.length) return;
  for (const id of ids) {
    db.run("UPDATE cos_reminders SET status = 'overdue' WHERE id = ? AND status = 'open'", [id]);
  }
  saveDb();
}
