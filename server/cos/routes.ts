// Chief of Staff API routes, mounted under /api/cos by registerRoutes().
import type { Express } from "express";
import * as storage from "../storage";
import { getEmailProvider, getTeamsProvider, type MessageProvider } from "./providers";
import { triageMessage } from "./triage";
import { analyzeIntake } from "./intake";
import { draftReply } from "./reply";
import { generateBrief } from "./brief";
import { bucketReminder, startReminderSweep, sweepOverdue } from "./reminders";

/** Fetch from all providers, triage anything new, and store in one batch write. */
export async function syncMessages(now: Date = new Date()): Promise<{ fetched: number; inserted: number }> {
  const providers: MessageProvider[] = [getEmailProvider(now), getTeamsProvider(now)];
  const rows: Parameters<typeof storage.cosInsertMessages>[0] = [];
  let fetched = 0;

  for (const provider of providers) {
    let msgs;
    try {
      msgs = await provider.fetchMessages();
    } catch (err) {
      console.error(`Provider ${provider.name} fetch failed:`, err);
      continue;
    }
    fetched += msgs.length;
    for (const m of msgs) {
      if (storage.cosMessageExists(m.external_id)) continue;
      const triage = await triageMessage(
        {
          source: provider.source,
          sender: m.sender,
          sender_role: m.sender_role,
          channel: m.channel,
          subject: m.subject,
          body: m.body,
          received_at: m.received_at,
        },
        now
      );
      rows.push({
        source: provider.source,
        external_id: m.external_id,
        sender: m.sender,
        sender_email: m.sender_email,
        sender_role: m.sender_role,
        channel: m.channel,
        subject: m.subject,
        body: m.body,
        received_at: m.received_at,
        is_read: 0,
        is_archived: 0,
        urgency: triage.urgency,
        category: triage.category,
        triage_summary: triage.summary,
        action_items: JSON.stringify(triage.action_items),
        suggested_deadline: triage.suggested_deadline,
        triaged_at: now.toISOString(),
      });
    }
  }

  const inserted = storage.cosInsertMessages(rows);
  return { fetched, inserted };
}

/** Seed demo matters, intake, and reminders once (messages come in via sync). */
export async function seedCosDemoData(now: Date = new Date()): Promise<void> {
  if (storage.cosGetMatters().length === 0) {
    storage.cosCreateMatter({
      client_name: "Meridian Health Systems",
      matter_name: "Meridian Health v. DataBridge Analytics",
      practice_area: "litigation",
      adverse_party: "DataBridge Analytics",
    });
    storage.cosCreateMatter({
      client_name: "Apex Manufacturing",
      matter_name: "Apex Manufacturing — Executive Separation",
      practice_area: "employment",
      adverse_party: null,
    });
  }

  if (storage.cosGetIntakes().length === 0) {
    storage.cosCreateIntake({
      client_name: "Brightline Logistics",
      contact_email: "elena.r@brightlinelogistics.example.com",
      matter_description:
        "Former VP of Operations was terminated for cause and has threatened a wrongful termination and discrimination lawsuit. He allegedly took confidential route-pricing data to a competitor, DataBridge Analytics. Company wants to assess defensive posture and a possible trade-secret claim. There is a board meeting next week and they want guidance before then.",
      source: "referral",
    });
  }

  if (storage.cosGetReminders().length === 0) {
    const h = (hours: number) => new Date(now.getTime() + hours * 3600000).toISOString();
    storage.cosCreateReminder({
      title: "File pro hac vice application — Meridian v. DataBridge",
      notes: "Local counsel needs the signed application before the motion hearing.",
      due_at: h(-20), priority: "high",
    });
    storage.cosCreateReminder({
      title: "Call Sarah Chen re: DataBridge contract termination",
      notes: "She needs options before the Meridian board meets Thursday.",
      due_at: h(6), priority: "critical",
    });
    storage.cosCreateReminder({
      title: "Review associate's opposition brief (Section III)",
      notes: "Comments due back to David so the team can file Friday.",
      due_at: h(30), priority: "high",
    });
    storage.cosCreateReminder({
      title: "Prepare pipeline notes for partner meeting",
      notes: "Top three BD prospects + engagement letter status.",
      due_at: h(72), priority: "medium",
    });
  }

  // First-run message sync so the app has data immediately
  if (storage.cosGetMessages({}).length === 0 && storage.cosGetMessages({ archived: true }).length === 0) {
    await syncMessages(now);
  }
}

export function registerCosRoutes(app: Express): void {
  startReminderSweep();

  // --- Daily brief ---
  app.get("/api/cos/brief", (_req, res) => {
    res.json(generateBrief());
  });

  // --- Sync ---
  app.post("/api/cos/sync", async (_req, res) => {
    try {
      const result = await syncMessages();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Sync failed" });
    }
  });

  // --- Messages ---
  app.get("/api/cos/messages", (req, res) => {
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const archived = req.query.archived === "true";
    res.json(storage.cosGetMessages({ source, archived }));
  });

  app.get("/api/cos/messages/:id", (req, res) => {
    const msg = storage.cosGetMessage(Number(req.params.id));
    if (!msg) return res.status(404).json({ error: "Message not found" });
    res.json(msg);
  });

  app.post("/api/cos/messages/:id/read", (req, res) => {
    const msg = storage.cosUpdateMessage(Number(req.params.id), { is_read: 1 });
    if (!msg) return res.status(404).json({ error: "Message not found" });
    res.json(msg);
  });

  app.post("/api/cos/messages/:id/archive", (req, res) => {
    const msg = storage.cosUpdateMessage(Number(req.params.id), { is_archived: 1, is_read: 1 });
    if (!msg) return res.status(404).json({ error: "Message not found" });
    res.json(msg);
  });

  app.post("/api/cos/messages/:id/draft-reply", async (req, res) => {
    const msg = storage.cosGetMessage(Number(req.params.id));
    if (!msg) return res.status(404).json({ error: "Message not found" });
    try {
      const reply = await draftReply(msg);
      res.json({ reply });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Draft failed" });
    }
  });

  app.post("/api/cos/messages/:id/to-reminder", (req, res) => {
    const msg = storage.cosGetMessage(Number(req.params.id));
    if (!msg) return res.status(404).json({ error: "Message not found" });
    const dueAt =
      (typeof req.body?.due_at === "string" && req.body.due_at) ||
      msg.suggested_deadline ||
      new Date(Date.now() + 24 * 3600000).toISOString();
    const reminder = storage.cosCreateReminder({
      title: req.body?.title || `Follow up: ${msg.subject || msg.sender}`,
      notes: msg.triage_summary,
      due_at: dueAt,
      priority: msg.urgency || "medium",
      source_type: "message",
      source_id: msg.id,
    });
    res.status(201).json(reminder);
  });

  // --- Intakes ---
  app.get("/api/cos/intakes", (_req, res) => {
    res.json(storage.cosGetIntakes());
  });

  app.get("/api/cos/intakes/:id", (req, res) => {
    const intake = storage.cosGetIntake(Number(req.params.id));
    if (!intake) return res.status(404).json({ error: "Intake not found" });
    res.json(intake);
  });

  app.post("/api/cos/intakes", (req, res) => {
    const { client_name, contact_email, matter_description, source } = req.body || {};
    if (!client_name || !matter_description) {
      return res.status(400).json({ error: "client_name and matter_description are required" });
    }
    const intake = storage.cosCreateIntake({ client_name, contact_email, matter_description, source });
    res.status(201).json(intake);
  });

  app.post("/api/cos/intakes/:id/analyze", async (req, res) => {
    const intake = storage.cosGetIntake(Number(req.params.id));
    if (!intake) return res.status(404).json({ error: "Intake not found" });
    try {
      const analysis = await analyzeIntake(
        {
          client_name: intake.client_name,
          contact_email: intake.contact_email,
          matter_description: intake.matter_description,
        },
        storage.cosGetMatters()
      );
      const updated = storage.cosUpdateIntake(intake.id, {
        analysis: JSON.stringify(analysis),
        analyzed_at: new Date().toISOString(),
        status: "analyzed",
      });
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Analysis failed" });
    }
  });

  app.post("/api/cos/intakes/:id/convert", (req, res) => {
    const intake = storage.cosGetIntake(Number(req.params.id));
    if (!intake) return res.status(404).json({ error: "Intake not found" });
    if (intake.matter_id) return res.status(409).json({ error: "Intake already converted" });
    let practiceArea = "general";
    let adverseParty: string | null = null;
    if (intake.analysis) {
      try {
        const a = JSON.parse(intake.analysis);
        practiceArea = a.practice_area || "general";
      } catch { /* keep defaults */ }
    }
    if (typeof req.body?.adverse_party === "string") adverseParty = req.body.adverse_party;
    const matter = storage.cosCreateMatter({
      client_name: intake.client_name,
      matter_name: req.body?.matter_name || `${intake.client_name} — New Matter`,
      practice_area: practiceArea,
      adverse_party: adverseParty,
    });
    const updated = storage.cosUpdateIntake(intake.id, { status: "converted", matter_id: matter.id });
    res.json({ intake: updated, matter });
  });

  // --- Matters ---
  app.get("/api/cos/matters", (_req, res) => {
    res.json(storage.cosGetMatters());
  });

  // --- Reminders ---
  app.get("/api/cos/reminders", (_req, res) => {
    sweepOverdue();
    const now = new Date();
    const reminders = storage.cosGetReminders().map(r => ({ ...r, bucket: bucketReminder(r, now) }));
    res.json(reminders);
  });

  app.post("/api/cos/reminders", (req, res) => {
    const { title, notes, due_at, priority } = req.body || {};
    if (!title || !due_at) return res.status(400).json({ error: "title and due_at are required" });
    if (isNaN(new Date(due_at).getTime())) return res.status(400).json({ error: "due_at must be a valid date" });
    const reminder = storage.cosCreateReminder({ title, notes, due_at, priority });
    res.status(201).json(reminder);
  });

  app.patch("/api/cos/reminders/:id", (req, res) => {
    const id = Number(req.params.id);
    const existing = storage.cosGetReminder(id);
    if (!existing) return res.status(404).json({ error: "Reminder not found" });

    const { action, title, notes, due_at, priority } = req.body || {};
    if (action === "complete") {
      return res.json(storage.cosUpdateReminder(id, { status: "done", completed_at: new Date().toISOString() }));
    }
    if (action === "reopen") {
      return res.json(storage.cosUpdateReminder(id, { status: "open", completed_at: null as any }));
    }
    if (action === "snooze") {
      const hours = Number(req.body?.hours) || 24;
      const base = Math.max(new Date(existing.due_at).getTime(), Date.now());
      return res.json(storage.cosUpdateReminder(id, {
        due_at: new Date(base + hours * 3600000).toISOString(),
        status: "open",
      }));
    }
    const updates: any = {};
    if (title !== undefined) updates.title = title;
    if (notes !== undefined) updates.notes = notes;
    if (due_at !== undefined) {
      if (isNaN(new Date(due_at).getTime())) return res.status(400).json({ error: "due_at must be a valid date" });
      updates.due_at = due_at;
      updates.status = "open";
    }
    if (priority !== undefined) updates.priority = priority;
    res.json(storage.cosUpdateReminder(id, updates));
  });

  app.delete("/api/cos/reminders/:id", (req, res) => {
    const existing = storage.cosGetReminder(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: "Reminder not found" });
    storage.cosDeleteReminder(Number(req.params.id));
    res.json({ ok: true });
  });
}
