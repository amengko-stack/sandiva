import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getEmailProvider, getTeamsProvider, mapOutlookMessage,
  DemoEmailProvider, OutlookMailProvider, GmailProvider, GraphTeamsProvider, DemoTeamsProvider,
} from "../providers";

const ENV_KEYS = [
  "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "COS_MAILBOX",
  "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "COS_FIRM_DOMAIN",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("provider selection", () => {
  it("uses demo providers without credentials", () => {
    expect(getEmailProvider()).toBeInstanceOf(DemoEmailProvider);
    expect(getTeamsProvider()).toBeInstanceOf(DemoTeamsProvider);
  });

  it("uses Outlook when Azure creds + mailbox are set", () => {
    process.env.AZURE_TENANT_ID = "t";
    process.env.AZURE_CLIENT_ID = "c";
    process.env.AZURE_CLIENT_SECRET = "s";
    process.env.COS_MAILBOX = "partner@firm.com";
    expect(getEmailProvider()).toBeInstanceOf(OutlookMailProvider);
    expect(getTeamsProvider()).toBeInstanceOf(GraphTeamsProvider);
  });

  it("stays on demo email when Azure creds lack a mailbox (Teams still real)", () => {
    process.env.AZURE_TENANT_ID = "t";
    process.env.AZURE_CLIENT_ID = "c";
    process.env.AZURE_CLIENT_SECRET = "s";
    expect(getEmailProvider()).toBeInstanceOf(DemoEmailProvider);
    expect(getTeamsProvider()).toBeInstanceOf(GraphTeamsProvider);
  });

  it("prefers Outlook over Gmail when both are configured", () => {
    process.env.AZURE_TENANT_ID = "t";
    process.env.AZURE_CLIENT_ID = "c";
    process.env.AZURE_CLIENT_SECRET = "s";
    process.env.COS_MAILBOX = "partner@firm.com";
    process.env.GMAIL_CLIENT_ID = "g";
    process.env.GMAIL_CLIENT_SECRET = "g";
    process.env.GMAIL_REFRESH_TOKEN = "g";
    expect(getEmailProvider()).toBeInstanceOf(OutlookMailProvider);
  });

  it("falls back to Gmail when only Gmail is configured", () => {
    process.env.GMAIL_CLIENT_ID = "g";
    process.env.GMAIL_CLIENT_SECRET = "g";
    process.env.GMAIL_REFRESH_TOKEN = "g";
    expect(getEmailProvider()).toBeInstanceOf(GmailProvider);
  });
});

describe("mapOutlookMessage", () => {
  const graphMsg = {
    id: "AAMkAD123",
    subject: "Settlement discussion",
    from: { emailAddress: { name: "Robert Vance", address: "rvance@vancecole.com" } },
    receivedDateTime: "2026-07-11T08:15:00Z",
    bodyPreview: "Counsel, please see the attached offer.",
    body: { contentType: "html", content: "<html><body><p>Counsel, please see the attached offer.</p></body></html>" },
  };

  it("maps sender, subject, body, and id", () => {
    const m = mapOutlookMessage(graphMsg);
    expect(m.external_id).toBe("outlook-AAMkAD123");
    expect(m.sender).toBe("Robert Vance");
    expect(m.sender_email).toBe("rvance@vancecole.com");
    expect(m.sender_role).toBe("other");
    expect(m.subject).toBe("Settlement discussion");
    expect(m.body).toBe("Counsel, please see the attached offer.");
    expect(m.received_at).toBe("2026-07-11T08:15:00Z");
  });

  it("strips HTML when bodyPreview is missing", () => {
    const m = mapOutlookMessage({ ...graphMsg, bodyPreview: "" });
    expect(m.body).toBe("Counsel, please see the attached offer.");
    expect(m.body).not.toContain("<");
  });

  it("marks firm-domain senders as internal (associate)", () => {
    const internal = {
      ...graphMsg,
      from: { emailAddress: { name: "David Okafor", address: "d.okafor@Firm.com" } },
    };
    expect(mapOutlookMessage(internal, "firm.com").sender_role).toBe("associate");
    expect(mapOutlookMessage(graphMsg, "firm.com").sender_role).toBe("other");
  });

  it("tolerates missing from field", () => {
    const m = mapOutlookMessage({ id: "x", receivedDateTime: "2026-07-11T08:15:00Z", bodyPreview: "hi" });
    expect(m.sender).toBe("Unknown");
    expect(m.sender_email).toBeNull();
  });
});
