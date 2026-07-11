// End-to-end API test: boots the real Express app (routes + storage + seed)
// against a temp DB (see setup.ts) and exercises the full COS surface.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "node:http";
import request from "supertest";

import { initDb } from "../../storage";
import { registerRoutes } from "../../routes";
import { seedCosDemoData } from "../routes";
import { stopReminderSweep } from "../reminders";

let app: express.Express;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  await initDb();
  registerRoutes(createServer(app), app);
  await seedCosDemoData();
});

afterAll(() => {
  stopReminderSweep();
});

describe("COS API", () => {
  it("seeded demo messages via sync and triaged them", async () => {
    const res = await request(app).get("/api/cos/messages?source=email").expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
    for (const m of res.body) {
      expect(m.source).toBe("email");
      expect(m.urgency).toBeTruthy();
      expect(m.category).toBeTruthy();
      expect(m.triage_summary).toBeTruthy();
    }
    const teams = await request(app).get("/api/cos/messages?source=teams").expect(200);
    expect(teams.body.length).toBeGreaterThanOrEqual(3);
  });

  it("re-sync does not duplicate messages", async () => {
    const before = (await request(app).get("/api/cos/messages").expect(200)).body.length;
    const sync = await request(app).post("/api/cos/sync").expect(200);
    expect(sync.body.inserted).toBe(0);
    const after = (await request(app).get("/api/cos/messages").expect(200)).body.length;
    expect(after).toBe(before);
  });

  it("generates a daily brief with ranked attention items and stats", async () => {
    const res = await request(app).get("/api/cos/brief").expect(200);
    const brief = res.body;
    expect(brief.attention_items.length).toBeGreaterThan(0);
    expect(brief.attention_items.length).toBeLessThanOrEqual(5);
    expect(brief.stats.unread_messages).toBeGreaterThan(0);
    expect(brief.stats.overdue_reminders).toBeGreaterThanOrEqual(1); // seeded overdue reminder
    // Ranked: first item should be critical (overdue reminder escalates)
    expect(brief.attention_items[0].urgency).toBe("critical");
    expect(brief.upcoming_deadlines.length).toBeGreaterThan(0);
  });

  it("marks messages read and archives them", async () => {
    const list = (await request(app).get("/api/cos/messages?source=email").expect(200)).body;
    const target = list[list.length - 1];
    const read = await request(app).post(`/api/cos/messages/${target.id}/read`).expect(200);
    expect(read.body.is_read).toBe(1);
    await request(app).post(`/api/cos/messages/${target.id}/archive`).expect(200);
    const remaining = (await request(app).get("/api/cos/messages?source=email").expect(200)).body;
    expect(remaining.find((m: any) => m.id === target.id)).toBeUndefined();
    const archived = (await request(app).get("/api/cos/messages?source=email&archived=true").expect(200)).body;
    expect(archived.find((m: any) => m.id === target.id)).toBeTruthy();
  });

  it("drafts a reply appropriate to the message category", async () => {
    const list = (await request(app).get("/api/cos/messages?source=email").expect(200)).body;
    const opposing = list.find((m: any) => m.category === "opposing_counsel");
    expect(opposing).toBeTruthy();
    const res = await request(app).post(`/api/cos/messages/${opposing.id}/draft-reply`).expect(200);
    expect(res.body.reply).toContain("Counsel");
    expect(res.body.reply).toContain("Best regards");
  });

  it("converts a message into a reminder", async () => {
    const list = (await request(app).get("/api/cos/messages?source=email").expect(200)).body;
    const target = list[0];
    const res = await request(app).post(`/api/cos/messages/${target.id}/to-reminder`).expect(201);
    expect(res.body.title).toContain(target.subject || target.sender);
    expect(res.body.source_type).toBe("message");
    expect(res.body.source_id).toBe(target.id);
  });

  it("404s on unknown message", async () => {
    await request(app).get("/api/cos/messages/999999").expect(404);
    await request(app).post("/api/cos/messages/999999/read").expect(404);
  });

  it("runs the full intake flow: create → analyze → convert to matter", async () => {
    const created = await request(app)
      .post("/api/cos/intakes")
      .send({
        client_name: "TestCo Industries",
        contact_email: "gc@testco.example.com",
        matter_description:
          "Our supplier breached the master agreement and refuses payment. We were sued in state court last week and there is a response deadline.",
        source: "manual",
      })
      .expect(201);
    expect(created.body.status).toBe("new");

    const analyzed = await request(app).post(`/api/cos/intakes/${created.body.id}/analyze`).expect(200);
    expect(analyzed.body.status).toBe("analyzed");
    const analysis = JSON.parse(analyzed.body.analysis);
    expect(["contract", "litigation"]).toContain(analysis.practice_area);
    expect(analysis.key_issues.length).toBeGreaterThan(0);
    expect(analysis.recommended_actions.length).toBeGreaterThan(0);
    expect(analysis.urgency).toBe("high");

    const mattersBefore = (await request(app).get("/api/cos/matters").expect(200)).body.length;
    const converted = await request(app)
      .post(`/api/cos/intakes/${created.body.id}/convert`)
      .send({ matter_name: "TestCo — Supplier Dispute", adverse_party: "SupplierCo" })
      .expect(200);
    expect(converted.body.intake.status).toBe("converted");
    expect(converted.body.matter.matter_name).toBe("TestCo — Supplier Dispute");
    const mattersAfter = (await request(app).get("/api/cos/matters").expect(200)).body.length;
    expect(mattersAfter).toBe(mattersBefore + 1);

    // Converting twice is rejected
    await request(app).post(`/api/cos/intakes/${created.body.id}/convert`).expect(409);
  });

  it("flags conflicts in intake analysis against seeded matters", async () => {
    const created = await request(app)
      .post("/api/cos/intakes")
      .send({
        client_name: "DataBridge Analytics",
        matter_description: "We would like help with an office lease renewal.",
      })
      .expect(201);
    const analyzed = await request(app).post(`/api/cos/intakes/${created.body.id}/analyze`).expect(200);
    const analysis = JSON.parse(analyzed.body.analysis);
    expect(analysis.conflict_flags.length).toBeGreaterThan(0);
  });

  it("validates intake creation", async () => {
    await request(app).post("/api/cos/intakes").send({ client_name: "NoDesc" }).expect(400);
  });

  it("runs the reminders lifecycle: create → snooze → complete → delete", async () => {
    const due = new Date(Date.now() + 3600000).toISOString();
    const created = await request(app)
      .post("/api/cos/reminders")
      .send({ title: "Call the mediator", due_at: due, priority: "high" })
      .expect(201);
    expect(created.body.status).toBe("open");

    const list = (await request(app).get("/api/cos/reminders").expect(200)).body;
    const mine = list.find((r: any) => r.id === created.body.id);
    expect(mine.bucket).toBe("today");

    const snoozed = await request(app)
      .patch(`/api/cos/reminders/${created.body.id}`)
      .send({ action: "snooze", hours: 48 })
      .expect(200);
    expect(new Date(snoozed.body.due_at).getTime()).toBeGreaterThan(new Date(due).getTime());

    const done = await request(app)
      .patch(`/api/cos/reminders/${created.body.id}`)
      .send({ action: "complete" })
      .expect(200);
    expect(done.body.status).toBe("done");
    expect(done.body.completed_at).toBeTruthy();

    await request(app).delete(`/api/cos/reminders/${created.body.id}`).expect(200);
    await request(app).delete(`/api/cos/reminders/${created.body.id}`).expect(404);
  });

  it("escalates past-due reminders to overdue on read", async () => {
    const created = await request(app)
      .post("/api/cos/reminders")
      .send({ title: "Should be overdue", due_at: new Date(Date.now() - 3600000).toISOString() })
      .expect(201);
    const list = (await request(app).get("/api/cos/reminders").expect(200)).body;
    const mine = list.find((r: any) => r.id === created.body.id);
    expect(mine.status).toBe("overdue");
    expect(mine.bucket).toBe("overdue");
  });

  it("validates reminder input", async () => {
    await request(app).post("/api/cos/reminders").send({ title: "no due date" }).expect(400);
    await request(app).post("/api/cos/reminders").send({ title: "bad date", due_at: "not-a-date" }).expect(400);
  });
});
