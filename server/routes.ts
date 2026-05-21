import type { Express } from "express";
import type { Server } from "http";
import multer from "multer";
import fs from "fs";
import nodemailer from "nodemailer";
import * as storage from "./storage";
import { parseWhatsAppChat, generateSummary, buildEmailReport } from "./llm";

const upload = multer({ dest: "uploads/", limits: { fileSize: 20 * 1024 * 1024 } });
fs.mkdirSync("uploads", { recursive: true });

function seedDemoData() {
  const existingGroups = storage.getGroups();
  if (existingGroups.length > 0) return;

  const groupDefs = [
    { name: "SANDIVA Legal Team", description: "Internal legal discussions and case updates", color: "#01696f" },
    { name: "Client – PT Maju Bersama", description: "Client coordination and deliverables", color: "#7a39bb" },
    { name: "Compliance & Regulatory", description: "Regulatory updates and compliance reviews", color: "#da7101" },
    { name: "Management Board", description: "Executive decisions and strategic planning", color: "#006494" },
  ];

  const today = new Date();
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const daysAgo = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };

  for (const gd of groupDefs) {
    const group = storage.createGroup(gd);
    if (!group) { console.error("Failed to create group:", gd.name); continue; }

    for (let i = 6; i >= 0; i--) {
      const date = fmt(daysAgo(i));
      const msgCount = Math.floor(Math.random() * 80) + 20;
      const session = storage.createUploadSession({
        groupId: group.id, filename: `${gd.name.replace(/\s/g, "_")}_${date}.txt`,
        uploadedAt: new Date().toISOString(), date, messageCount: msgCount, status: "done", rawContent: null,
      });

      const demoSummaries: Record<string, any> = {
        "SANDIVA Legal Team": {
          overview: "Team reviewed the draft contract for Bumi Resources acquisition and discussed timeline adjustments. Ahmad flagged potential compliance issue in clause 7.3 that needs review before submission.",
          keyTopics: ["Contract Review", "Compliance", "Bumi Resources", "Due Diligence"],
          actionItems: [
            { text: "Review clause 7.3 for regulatory compliance", assignee: "Ahmad", priority: "high" },
            { text: "Prepare revised timeline for client presentation", assignee: "Sari", priority: "medium" },
            { text: "Send updated NDA to procurement team", assignee: "Team", priority: "low" },
          ],
          decisions: ["Extend due diligence period by 5 business days", "Escalate clause 7.3 to senior partner for review"],
          importantMentions: [
            { person: "Ahmad", context: "Flagged critical compliance issue requiring immediate attention" },
            { person: "Budi Santoso", context: "Client representative mentioned in contract discussion" },
          ],
          sentiment: "neutral",
        },
        "Client – PT Maju Bersama": {
          overview: "Discussed deliverable schedule for Q2 regulatory filing. Client confirmed receipt of initial legal opinion. Follow-up meeting scheduled for next week.",
          keyTopics: ["Q2 Filing", "Legal Opinion", "Deliverables", "Meeting Schedule"],
          actionItems: [
            { text: "Finalize legal opinion document", assignee: "Reza", priority: "high" },
            { text: "Schedule follow-up call with client", assignee: "Sari", priority: "medium" },
          ],
          decisions: ["Confirm meeting date for May 28", "Submit draft to client by Friday"],
          importantMentions: [{ person: "Pak Hendra", context: "Client confirmed receipt and requested addendum" }],
          sentiment: "positive",
        },
        "Compliance & Regulatory": {
          overview: "OJK issued new circular on data governance requirements. Team needs to assess impact on current client contracts and update compliance checklists.",
          keyTopics: ["OJK Circular", "Data Governance", "Compliance Update", "Risk Assessment"],
          actionItems: [
            { text: "Review new OJK circular on data governance", assignee: "Team", priority: "high" },
            { text: "Update compliance checklist template", assignee: "Dewi", priority: "high" },
            { text: "Notify affected clients of regulatory change", assignee: "Ahmad", priority: "medium" },
          ],
          decisions: ["Conduct emergency compliance review this week", "Brief all clients by end of month"],
          importantMentions: [{ person: "Dewi", context: "Volunteered to lead the compliance review process" }],
          sentiment: "negative",
        },
        "Management Board": {
          overview: "Monthly board sync covered Q1 financial performance, new client pipeline, and team expansion plans. Decision made to hire two additional associates in H2 2026.",
          keyTopics: ["Q1 Performance", "Hiring Plan", "Client Pipeline", "H2 Strategy"],
          actionItems: [
            { text: "Prepare H2 hiring plan and budget", assignee: "HR", priority: "medium" },
            { text: "Finalize Q1 financial report for partners", assignee: "Finance", priority: "high" },
          ],
          decisions: ["Approve 2 associate hires for H2 2026", "Expand to Surabaya office in Q3"],
          importantMentions: [{ person: "Managing Partner", context: "Approved expansion budget for Surabaya office" }],
          sentiment: "positive",
        },
      };

      const s = demoSummaries[gd.name] || demoSummaries["SANDIVA Legal Team"];
      storage.createSummary({
        sessionId: session.id, groupId: group.id, date,
        overview: s.overview,
        keyTopics: JSON.stringify(s.keyTopics),
        actionItems: JSON.stringify(s.actionItems),
        decisions: JSON.stringify(s.decisions),
        importantMentions: JSON.stringify(s.importantMentions),
        sentiment: s.sentiment,
        createdAt: new Date().toISOString(),
      });

      const names = ["Ahmad", "Sari", "Reza", "Dewi"];
      storage.upsertParticipants(names.map(name => ({
        sessionId: session.id, groupId: group.id, date, name,
        messageCount: Math.floor(Math.random() * 30) + 5,
        wordCount: Math.floor(Math.random() * 200) + 50,
        actionItemsOwned: Math.floor(Math.random() * 3),
      })));
    }

    const weekStart = fmt(daysAgo(7));
    const trendTopics: Record<string, any[]> = {
      "SANDIVA Legal Team": [
        { topic: "Contract Review", count: 45, trend: "up" }, { topic: "Compliance", count: 38, trend: "up" },
        { topic: "Due Diligence", count: 22, trend: "flat" }, { topic: "NDA", count: 15, trend: "down" }, { topic: "Litigation", count: 8, trend: "flat" },
      ],
      "Client – PT Maju Bersama": [
        { topic: "Q2 Filing", count: 31, trend: "up" }, { topic: "Legal Opinion", count: 28, trend: "up" },
        { topic: "Deliverables", count: 19, trend: "flat" }, { topic: "Meetings", count: 12, trend: "up" },
      ],
      "Compliance & Regulatory": [
        { topic: "OJK Circular", count: 52, trend: "up" }, { topic: "Data Governance", count: 47, trend: "up" },
        { topic: "Risk Assessment", count: 30, trend: "up" }, { topic: "Client Impact", count: 18, trend: "up" },
      ],
      "Management Board": [
        { topic: "Q1 Performance", count: 24, trend: "flat" }, { topic: "Hiring Plan", count: 19, trend: "up" },
        { topic: "H2 Strategy", count: 17, trend: "up" }, { topic: "Budget", count: 12, trend: "flat" },
      ],
    };
    storage.upsertTopicTrend({
      groupId: group.id, weekStart,
      topics: JSON.stringify(trendTopics[gd.name] || trendTopics["SANDIVA Legal Team"]),
      updatedAt: new Date().toISOString(),
    });
  }
}

export function registerRoutes(httpServer: Server, app: Express) {
  // Demo data is no longer auto-seeded — uploads should create real groups.
  // To re-seed for testing, call seedDemoData() manually.

  // Wipe ALL data (groups, sessions, summaries, participants, trends).
  // Useful for clearing the original demo seed in one click from the UI.
  app.post("/api/admin/wipe-all", (_req, res) => {
    const groups = storage.getGroups() as any[];
    for (const g of groups) storage.deleteGroup(g.id);
    res.json({ ok: true, deleted: groups.length });
  });

  // Groups
  app.get("/api/groups", (req, res) => res.json(storage.getGroups()));

  app.post("/api/groups", (req, res) => {
    const { name, description, color } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    res.json(storage.createGroup({ name, description, color }));
  });

  app.put("/api/groups/:id", (req, res) => {
    const g = storage.updateGroup(parseInt(req.params.id), req.body);
    if (!g) return res.status(404).json({ error: "Not found" });
    res.json(g);
  });

  app.delete("/api/groups/:id", (req, res) => {
    storage.deleteGroup(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // Dashboard
  app.get("/api/dashboard", (req, res) => {
    const groups = storage.getGroups();
    const result = groups.map(g => {
      const rawSummaries = storage.getSummaries(g.id, 1);
      const latestRaw = rawSummaries[0] || null;
      const latestSummary = latestRaw ? {
        ...latestRaw,
        keyTopics: JSON.parse(latestRaw.key_topics || "[]"),
        actionItems: JSON.parse(latestRaw.action_items || "[]"),
        decisions: JSON.parse(latestRaw.decisions || "[]"),
        importantMentions: JSON.parse(latestRaw.important_mentions || "[]"),
      } : null;
      const sessions = storage.getUploadSessions(g.id);
      const recentParticipants = latestRaw ? storage.getParticipants(latestRaw.session_id) : [];
      return {
        group: g,
        latestSummary,
        totalMessages: sessions.reduce((s: number, u: any) => s + (u.message_count || 0), 0),
        sessionCount: sessions.length,
        participants: recentParticipants,
      };
    });
    res.json(result);
  });

  // Upload
  app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
      const { groupId, date } = req.body;
      if (!req.file) return res.status(400).json({ error: "Missing file" });

      const content = fs.readFileSync(req.file.path, "utf-8");
      const parsed = parseWhatsAppChat(content);

      // Resolve target group. Priority:
      //   1) explicit groupId from the form
      //   2) detected group name from the WhatsApp file — reuse existing group with that
      //      name, or create a new one
      //   3) fall back to the filename so the upload never fails
      let group: any = null;
      if (groupId) {
        group = storage.getGroup(parseInt(groupId));
        if (!group) return res.status(404).json({ error: "Group not found" });
      } else {
        const candidateName =
          parsed.detectedGroupName ||
          req.file.originalname.replace(/\.txt$/i, "").replace(/^_chat\s*/i, "").trim() ||
          "Untitled chat";
        const existing = (storage.getGroups() as any[]).find(
          g => g.name.toLowerCase() === candidateName.toLowerCase()
        );
        group = existing || storage.createGroup({ name: candidateName });
      }
      const gid = group.id;

      const session = storage.createUploadSession({
        groupId: gid, filename: req.file.originalname,
        uploadedAt: new Date().toISOString(),
        date: date || new Date().toISOString().split("T")[0],
        messageCount: parsed.messages.length, status: "processing", rawContent: null,
      });

      generateSummary(parsed, group.name).then(result => {
        storage.createSummary({
          sessionId: session.id, groupId: gid,
          date: date || new Date().toISOString().split("T")[0],
          overview: result.overview,
          keyTopics: JSON.stringify(result.keyTopics),
          actionItems: JSON.stringify(result.actionItems),
          decisions: JSON.stringify(result.decisions),
          importantMentions: JSON.stringify(result.importantMentions),
          sentiment: result.sentiment, createdAt: new Date().toISOString(),
        });
        storage.upsertParticipants(parsed.participants.map(p => ({
          sessionId: session.id, groupId: gid,
          date: date || new Date().toISOString().split("T")[0],
          name: p.name, messageCount: p.messageCount, wordCount: p.wordCount, actionItemsOwned: 0,
        })));
        storage.updateUploadSession(session.id, { status: "done" });
      }).catch(() => storage.updateUploadSession(session.id, { status: "error" }));

      res.json({
        session,
        group,
        detectedGroupName: parsed.detectedGroupName,
        messageCount: parsed.messages.length,
        participants: parsed.participants,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to process file" });
    }
  });

  // Summaries
  app.get("/api/groups/:id/summaries", (req, res) => {
    const raw = storage.getSummaries(parseInt(req.params.id), 14);
    res.json(raw.map((s: any) => ({
      ...s,
      keyTopics: JSON.parse(s.key_topics || "[]"),
      actionItems: JSON.parse(s.action_items || "[]"),
      decisions: JSON.parse(s.decisions || "[]"),
      importantMentions: JSON.parse(s.important_mentions || "[]"),
    })));
  });

  // Participants
  app.get("/api/groups/:id/participants", (req, res) => {
    const all = storage.getParticipantsByGroup(parseInt(req.params.id));
    const agg = new Map<string, any>();
    for (const p of all as any[]) {
      if (!agg.has(p.name)) agg.set(p.name, { name: p.name, messageCount: 0, wordCount: 0, actionItemsOwned: 0, days: 0 });
      const a = agg.get(p.name);
      a.messageCount += p.message_count;
      a.wordCount += p.word_count;
      a.actionItemsOwned += p.action_items_owned;
      a.days++;
    }
    res.json(Array.from(agg.values()).sort((a, b) => b.messageCount - a.messageCount));
  });

  // Trends
  app.get("/api/groups/:id/trends", (req, res) => {
    const trends = storage.getTopicTrends(parseInt(req.params.id));
    res.json((trends as any[]).map(t => ({ ...t, topics: JSON.parse(t.topics || "[]") })));
  });

  // Report configs
  app.get("/api/report-configs", (req, res) => res.json(storage.getReportConfigs()));

  app.post("/api/report-configs", (req, res) => {
    const { channel, destination, frequency } = req.body;
    if (!destination) return res.status(400).json({ error: "Destination required" });
    res.json(storage.createReportConfig({ channel, destination, frequency }));
  });

  app.put("/api/report-configs/:id", (req, res) => {
    const config = storage.updateReportConfig(parseInt(req.params.id), req.body);
    if (!config) return res.status(404).json({ error: "Not found" });
    res.json(config);
  });

  app.delete("/api/report-configs/:id", (req, res) => {
    storage.deleteReportConfig(parseInt(req.params.id));
    res.json({ ok: true });
  });

  // Send report now
  app.post("/api/report-configs/:id/send-now", async (req, res) => {
    const configs = storage.getReportConfigs() as any[];
    const config = configs.find(c => c.id === parseInt(req.params.id));
    if (!config) return res.status(404).json({ error: "Not found" });

    const groups = storage.getGroups() as any[];
    const reportGroups = groups.map(g => {
      const rawSummaries = storage.getSummaries(g.id, 1);
      const s = rawSummaries[0] as any;
      if (!s) return null;
      return {
        name: g.name,
        summary: {
          overview: s.overview,
          keyTopics: JSON.parse(s.key_topics || "[]"),
          actionItems: JSON.parse(s.action_items || "[]"),
          decisions: JSON.parse(s.decisions || "[]"),
          importantMentions: JSON.parse(s.important_mentions || "[]"),
          sentiment: s.sentiment,
          topicsForTrend: [],
        },
        participants: [],
      };
    }).filter(Boolean);

    const html = buildEmailReport({
      groups: reportGroups as any,
      reportDate: new Date().toLocaleDateString("id-ID", { year: "numeric", month: "long", day: "numeric" }),
    });

    if (config.channel === "email") {
      try {
        const transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        });
        await transporter.sendMail({
          from: process.env.EMAIL_USER, to: config.destination,
          subject: `WhatsApp Group Report – ${new Date().toLocaleDateString("id-ID")}`, html,
        });
        storage.updateReportConfig(config.id, { lastSent: new Date().toISOString() });
        res.json({ ok: true, message: "Email sent successfully" });
      } catch (err: any) {
        res.status(500).json({ error: "Email failed: " + err.message });
      }
    } else if (config.channel === "slack") {
      try {
        const text = reportGroups.map((g: any) => `*${g.name}*\n${g.summary.overview}`).join("\n\n");
        const r = await fetch(config.destination, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `📊 *WhatsApp Group Daily Report*\n\n${text}` }),
        });
        if (!r.ok) throw new Error("Slack responded " + r.status);
        storage.updateReportConfig(config.id, { lastSent: new Date().toISOString() });
        res.json({ ok: true, message: "Slack message sent" });
      } catch (err: any) {
        res.status(500).json({ error: "Slack failed: " + err.message });
      }
    } else {
      res.status(400).json({ error: "Unknown channel" });
    }
  });
}
