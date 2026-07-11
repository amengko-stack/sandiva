// Message source connectors. A provider fetches raw messages from a source
// (email inbox / MS Teams). Real providers activate when credentials are
// present in the environment; otherwise realistic demo providers are used so
// the app works end-to-end without secrets.
import type { CosSource } from "@shared/schema";

export interface ProviderMessage {
  external_id: string;
  sender: string;
  sender_email: string | null;
  sender_role: string;
  channel: string | null;
  subject: string | null;
  body: string;
  received_at: string;
}

export interface MessageProvider {
  source: CosSource;
  name: string;
  fetchMessages(): Promise<ProviderMessage[]>;
}

function hoursAgo(h: number, now: Date): string {
  return new Date(now.getTime() - h * 3600000).toISOString();
}
function hoursAhead(h: number, now: Date): Date {
  return new Date(now.getTime() + h * 3600000);
}
function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Demo providers — a realistic week in the life of a litigation partner.
// Timestamps are generated relative to "now" so the demo always looks live.
// ---------------------------------------------------------------------------

export class DemoEmailProvider implements MessageProvider {
  source: CosSource = "email";
  name = "Demo Inbox";
  constructor(private now: Date = new Date()) {}

  async fetchMessages(): Promise<ProviderMessage[]> {
    const now = this.now;
    const hearingDate = fmtDate(hoursAhead(24 * 7, now));
    const offerDeadline = fmtDate(hoursAhead(24 * 4, now));
    return [
      {
        external_id: "demo-email-001",
        sender: "Sarah Chen",
        sender_email: "s.chen@meridianhealth.example.com",
        sender_role: "client",
        channel: null,
        subject: "URGENT: DataBridge terminated our data services contract",
        body: `We received written notice this morning that DataBridge Analytics is terminating the master data services agreement effective end of this week, citing our alleged non-payment. This is wrong — we have wire confirmations for every invoice. Their termination would take our patient billing system offline.\n\nPlease call me today to discuss a response strategy. We need to know by tomorrow whether we should seek emergency relief. The board meets Thursday and I need to brief them on our options.`,
        received_at: hoursAgo(2, now),
      },
      {
        external_id: "demo-email-002",
        sender: "Clerk of Court, Superior Court",
        sender_email: "efiling@courts.example.gov",
        sender_role: "court",
        channel: null,
        subject: `Notice of Hearing — Meridian Health Systems v. DataBridge Analytics (Case No. 26-CV-04412)`,
        body: `NOTICE OF HEARING\n\nPlease take notice that the hearing on Plaintiff's Motion to Compel Discovery Responses is set for ${hearingDate} at 9:00 AM in Department 12.\n\nAll parties must file any supplemental briefing no later than five (5) court days before the hearing. Failure to appear may result in sanctions.`,
        received_at: hoursAgo(5, now),
      },
      {
        external_id: "demo-email-003",
        sender: "Robert Vance",
        sender_email: "rvance@vancecole.example.com",
        sender_role: "opposing_counsel",
        channel: null,
        subject: "Meridian v. DataBridge — Settlement Offer (expires " + offerDeadline + ")",
        body: `Counsel,\n\nOn behalf of DataBridge Analytics, we are authorized to convey a settlement offer of $1.85M inclusive of fees, conditioned on dismissal with prejudice and mutual releases. This offer expires at 5:00 PM on ${offerDeadline} and will not be renewed.\n\nPlease respond by the deadline. We remain available to discuss terms this week.`,
        received_at: hoursAgo(20, now),
      },
      {
        external_id: "demo-email-004",
        sender: "David Okafor",
        sender_email: "d.okafor@firm.example.com",
        sender_role: "associate",
        channel: null,
        subject: "Draft opposition brief — need your comments by Thursday",
        body: `Hi,\n\nAttached is the draft opposition to DataBridge's motion for protective order. The argument on trade-secret waiver in Section III could use your judgment — I've flagged two alternative framings.\n\nCould you review and send comments by Thursday so we can file Friday morning? Word count is under the limit.`,
        received_at: hoursAgo(3, now),
      },
      {
        external_id: "demo-email-005",
        sender: "State Bar CLE Center",
        sender_email: "newsletter@barcle.example.org",
        sender_role: "vendor",
        channel: null,
        subject: "Newsletter: Upcoming CLE webinar — Ethics in the AI Era (1.5 credits)",
        body: `Join our upcoming CLE webinar on ethics obligations when using AI tools in practice. Earn 1.5 ethics credits. Register by end of month for the early-bird rate. Unsubscribe at any time.`,
        received_at: hoursAgo(26, now),
      },
      {
        external_id: "demo-email-006",
        sender: "Elena Rodriguez",
        sender_email: "elena.r@brightlinelogistics.example.com",
        sender_role: "other",
        channel: null,
        subject: "Seeking representation — employment dispute",
        body: `Dear Counsel,\n\nI am the COO of Brightline Logistics. We were referred to you by Tom Askew at Meridian. Our former VP of Operations was terminated for cause last month and has now threatened a wrongful termination and discrimination lawsuit. He has also taken confidential route-pricing data to a competitor, DataBridge Analytics.\n\nWe would like to retain your firm. Could we schedule a call this week to discuss?`,
        received_at: hoursAgo(8, now),
      },
    ];
  }
}

export class DemoTeamsProvider implements MessageProvider {
  source: CosSource = "teams";
  name = "Demo Teams";
  constructor(private now: Date = new Date()) {}

  async fetchMessages(): Promise<ProviderMessage[]> {
    const now = this.now;
    const filingDate = fmtDate(hoursAhead(24 * 6, now));
    return [
      {
        external_id: "demo-teams-001",
        sender: "Priya Natarajan",
        sender_email: "p.natarajan@firm.example.com",
        sender_role: "associate",
        channel: "Litigation Team",
        subject: null,
        body: `Reminder: our opposition to the motion to compel is due ${filingDate}. We need partner sign-off on the final draft by EOD Wednesday to make the filing deadline. @Partner please confirm you can review tomorrow.`,
        received_at: hoursAgo(1, now),
      },
      {
        external_id: "demo-teams-002",
        sender: "David Okafor",
        sender_email: "d.okafor@firm.example.com",
        sender_role: "associate",
        channel: "DM",
        subject: null,
        body: `Quick question on the Meridian discovery scope — opposing counsel is refusing to produce the internal billing audit, claiming privilege. Do you want me to draft a meet-and-confer letter or go straight to a motion? Let me know how you'd like to proceed.`,
        received_at: hoursAgo(4, now),
      },
      {
        external_id: "demo-teams-003",
        sender: "Firm Operations",
        sender_email: "ops@firm.example.com",
        sender_role: "staff",
        channel: "Firm Announcements",
        subject: null,
        body: `Heads up: the parking garage on Level 2 will be closed for maintenance this weekend. Please use the street entrance. Office supplies orders go out Friday.`,
        received_at: hoursAgo(22, now),
      },
      {
        external_id: "demo-teams-004",
        sender: "Margaret Liu",
        sender_email: "m.liu@firm.example.com",
        sender_role: "partner",
        channel: "Partners",
        subject: null,
        body: `Pipeline review moved to Thursday 4 PM. Please come with your top three business development prospects and the status of any pending engagement letters. The Brightline Logistics referral should be on the list if intake clears conflicts.`,
        received_at: hoursAgo(6, now),
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Real providers — activated by environment variables.
// ---------------------------------------------------------------------------

// Shared Microsoft Graph client-credentials auth (Teams + Outlook mail).
let _graphToken: { value: string; expiresAt: number } | null = null;
export async function getGraphToken(): Promise<string> {
  if (_graphToken && Date.now() < _graphToken.expiresAt - 60000) return _graphToken.value;
  const tenant = process.env.AZURE_TENANT_ID!;
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID!,
      client_secret: process.env.AZURE_CLIENT_SECRET!,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Graph token request failed: ${res.status}`);
  const data = await res.json();
  _graphToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return _graphToken.value;
}

function stripHtml(html: string): string {
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Microsoft Graph (client credentials) — reads recent messages from configured Teams chats/channels. */
export class GraphTeamsProvider implements MessageProvider {
  source: CosSource = "teams";
  name = "Microsoft Teams (Graph)";

  async fetchMessages(): Promise<ProviderMessage[]> {
    const token = await getGraphToken();
    // TEAMS_CHAT_IDS: comma-separated Graph chat ids to poll
    const chatIds = (process.env.TEAMS_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    const out: ProviderMessage[] = [];
    for (const chatId of chatIds) {
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chatId)}/messages?$top=25`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const msg of data.value || []) {
        if (!msg.body?.content) continue;
        out.push({
          external_id: `graph-${msg.id}`,
          sender: msg.from?.user?.displayName || "Unknown",
          sender_email: null,
          sender_role: "other",
          channel: chatId,
          subject: msg.subject || null,
          body: stripHtml(msg.body.content),
          received_at: msg.createdDateTime || new Date().toISOString(),
        });
      }
    }
    return out;
  }
}

/** Map a Graph mail message (users/{id}/messages item) to a ProviderMessage. Pure — unit tested. */
export function mapOutlookMessage(msg: any, firmDomain?: string): ProviderMessage {
  const from = msg.from?.emailAddress || {};
  const email: string | null = from.address || null;
  const domain = email?.split("@")[1]?.toLowerCase();
  const isInternal = Boolean(firmDomain && domain === firmDomain.toLowerCase());
  return {
    external_id: `outlook-${msg.id}`,
    sender: from.name || email || "Unknown",
    sender_email: email,
    sender_role: isInternal ? "associate" : "other",
    channel: null,
    subject: msg.subject || null,
    body: msg.bodyPreview || (msg.body?.content ? stripHtml(msg.body.content) : ""),
    received_at: msg.receivedDateTime || new Date().toISOString(),
  };
}

/** Office 365 / Outlook mail via Microsoft Graph (client credentials, Mail.Read application permission). */
export class OutlookMailProvider implements MessageProvider {
  source: CosSource = "email";
  name = "Outlook (Microsoft Graph)";

  async fetchMessages(): Promise<ProviderMessage[]> {
    const token = await getGraphToken();
    const mailbox = process.env.COS_MAILBOX!;
    const url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
      `?$top=25&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,body`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Outlook mail fetch failed: ${res.status} ${await res.text().catch(() => "")}`);
    const data = await res.json();
    const firmDomain = process.env.COS_FIRM_DOMAIN;
    return (data.value || []).map((msg: any) => mapOutlookMessage(msg, firmDomain));
  }
}

/** Gmail REST API via OAuth refresh token. */
export class GmailProvider implements MessageProvider {
  source: CosSource = "email";
  name = "Gmail";

  private async getAccessToken(): Promise<string> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID!,
        client_secret: process.env.GMAIL_CLIENT_SECRET!,
        refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`Gmail token request failed: ${res.status}`);
    return (await res.json()).access_token;
  }

  async fetchMessages(): Promise<ProviderMessage[]> {
    const token = await this.getAccessToken();
    const headers = { Authorization: `Bearer ${token}` };
    const listRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=in:inbox",
      { headers }
    );
    if (!listRes.ok) throw new Error(`Gmail list failed: ${listRes.status}`);
    const list = await listRes.json();
    const out: ProviderMessage[] = [];
    for (const ref of list.messages || []) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
        { headers }
      );
      if (!msgRes.ok) continue;
      const msg = await msgRes.json();
      const header = (name: string) =>
        msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name)?.value || null;
      const fromRaw = header("from") || "Unknown";
      const emailMatch = fromRaw.match(/<(.+)>/);
      out.push({
        external_id: `gmail-${msg.id}`,
        sender: fromRaw.replace(/<.+>/, "").replace(/"/g, "").trim() || fromRaw,
        sender_email: emailMatch ? emailMatch[1] : fromRaw,
        sender_role: "other",
        channel: null,
        subject: header("subject"),
        body: msg.snippet || "",
        received_at: new Date(parseInt(msg.internalDate || Date.now().toString(), 10)).toISOString(),
      });
    }
    return out;
  }
}

export function getEmailProvider(now: Date = new Date()): MessageProvider {
  if (
    process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID &&
    process.env.AZURE_CLIENT_SECRET && process.env.COS_MAILBOX
  ) {
    return new OutlookMailProvider();
  }
  if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
    return new GmailProvider();
  }
  return new DemoEmailProvider(now);
}

export function getTeamsProvider(now: Date = new Date()): MessageProvider {
  if (process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET) {
    return new GraphTeamsProvider();
  }
  return new DemoTeamsProvider(now);
}
