import initSqlJs, { Database } from "sql.js";
import fs from "fs";
import path from "path";

const DB_PATH = path.resolve("data.db");

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
      raw_content TEXT,
      last_signature TEXT
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
  `);
  // Migration for databases created before incremental uploads existed — adds the
  // last_signature column if it's missing. ALTER TABLE ADD COLUMN throws if the
  // column already exists, so swallow that case.
  try { db.run("ALTER TABLE upload_sessions ADD COLUMN last_signature TEXT"); } catch {}
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

function run(sql: string, params: any[] = []) {
  db.run(sql, params);
  saveDb();
}

function lastInsertId(): number {
  const res = db.exec("SELECT last_insert_rowid() as id");
  if (res.length > 0 && res[0].values.length > 0) {
    return res[0].values[0][0] as number;
  }
  return 0;
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
  // Cascade — remove everything that references this group, otherwise orphan rows
  // pollute the dashboard and aggregate queries.
  run("DELETE FROM participants WHERE group_id = ?", [id]);
  run("DELETE FROM summaries WHERE group_id = ?", [id]);
  run("DELETE FROM upload_sessions WHERE group_id = ?", [id]);
  run("DELETE FROM topic_trends WHERE group_id = ?", [id]);
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
  run("INSERT INTO upload_sessions (group_id, filename, uploaded_at, date, message_count, status, raw_content, last_signature) VALUES (?,?,?,?,?,?,?,?)", [
    data.groupId, data.filename, data.uploadedAt, data.date, data.messageCount, data.status, data.rawContent || null, data.lastSignature || null
  ]);
  const id = lastInsertId();
  const row = getUploadSession(id);
  if (row) return row;
  const rows = query("SELECT * FROM upload_sessions WHERE group_id = ? ORDER BY id DESC LIMIT 1", [data.groupId]);
  return rows[0] || { id, ...data };
}

// Returns the most recent upload session for a group (any status), used to find
// the signature we left off at on the previous incremental run.
export function getLatestUploadSession(groupId: number) {
  return query("SELECT * FROM upload_sessions WHERE group_id = ? ORDER BY id DESC LIMIT 1", [groupId])[0] || null;
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
  // Tie-break by id DESC so the most recently inserted summary for the same date wins.
  // Without this, demo seed rows and a same-day user upload were ordered nondeterministically.
  if (groupId) return query("SELECT * FROM summaries WHERE group_id = ? ORDER BY date DESC, id DESC LIMIT ?", [groupId, limit]);
  return query("SELECT * FROM summaries ORDER BY date DESC, id DESC LIMIT ?", [limit]);
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
