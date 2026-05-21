import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "dummy" });
  }
  return _client;
}

export interface ChatMessage {
  timestamp: string;
  sender: string;
  content: string;
}

export interface ParsedChat {
  messages: ChatMessage[];
  participants: { name: string; messageCount: number; wordCount: number }[];
  dateRange: { start: string; end: string };
  detectedGroupName: string | null;
}

export interface SummaryResult {
  overview: string;
  keyTopics: string[];
  actionItems: { text: string; assignee: string; priority: "high" | "medium" | "low" }[];
  decisions: string[];
  importantMentions: { person: string; context: string }[];
  sentiment: "positive" | "neutral" | "negative";
  topicsForTrend: string[];
}

// Parse WhatsApp exported chat (.txt format)
export function parseWhatsAppChat(content: string): ParsedChat {
  // Strip BOM, left-to-right marks (U+200E) and other zero-width chars that iOS exports
  // sprinkle through the file. Replace narrow no-break space (U+202F, used before AM/PM
  // on iOS) with a regular space. Without this cleanup the line-start regex misses every line.
  const cleaned = content
    .replace(/﻿/g, "")
    .replace(/[‎‏​‌‍]/g, "")
    .replace(/ | /g, " ");

  const lines = cleaned.split(/\r?\n/);
  const messages: ChatMessage[] = [];

  // Supports many WhatsApp export variants:
  //   [DD/MM/YY, HH:MM:SS] Sender: message       (iOS, with brackets)
  //   [DD/MM/YY, HH.MM.SS] Sender: message       (iOS, ID/EU locale uses "." in time)
  //   DD/MM/YY, HH:MM - Sender: message          (Android)
  //   DD.MM.YY HH:MM - Sender: message           (some EU locales)
  //   M/D/YY, H:MM PM - Sender: message          (US 12-hour)
  // Date separator: / . or -
  // Time separator: : or .
  // Sender ends at the FIRST colon that's followed by a space (so names containing ":" still work for the common case).
  const DATE = String.raw`\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}`;
  const TIME = String.raw`\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[AP]M)?`;
  const patterns = [
    // [date, time] sender: msg
    new RegExp(String.raw`^\[\s*(${DATE})[,\s]+(${TIME})\s*\]\s*([^:]+?):\s+([\s\S]*)$`, "i"),
    // date, time - sender: msg   (also handles "date time - ...")
    new RegExp(String.raw`^(${DATE})[,\s]+(${TIME})\s*[-–]\s*([^:]+?):\s+([\s\S]*)$`, "i"),
  ];

  let currentMsg: ChatMessage | null = null;

  for (const line of lines) {
    let matched = false;
    for (const pattern of patterns) {
      const m = line.match(pattern);
      if (m) {
        if (currentMsg) messages.push(currentMsg);
        currentMsg = {
          timestamp: `${m[1]} ${m[2]}`,
          sender: m[3].trim(),
          content: m[4].trim(),
        };
        matched = true;
        break;
      }
    }
    if (!matched && currentMsg && line.trim()) {
      currentMsg.content += "\n" + line.trim();
    }
  }
  if (currentMsg) messages.push(currentMsg);

  // Detect the WhatsApp group/chat name from the encryption-notice line. WhatsApp emits
  // "Messages and calls are end-to-end encrypted..." as the very first message, and the
  // "sender" of that line is the group name (or contact name for 1-on-1 chats).
  let detectedGroupName: string | null = null;
  for (const m of messages.slice(0, 5)) {
    if (/end-to-end encrypted/i.test(m.content)) {
      detectedGroupName = m.sender.replace(/^~\s*/, "").trim() || null;
      break;
    }
  }

  // Drop WhatsApp system notices that aren't real conversation (encryption notice,
  // "X added you", "X created this group", "<Media omitted>", etc.). These look like
  // regular messages but pollute participant counts and waste LLM tokens.
  const systemPatterns = [
    /end-to-end encrypted/i,
    /created this group/i,
    /added you/i,
    /^you were added/i,
    /^messages? and calls? are/i,
    /<media omitted>/i,
    /this message was deleted/i,
    /changed the (group )?(subject|description|icon)/i,
    /changed this group's icon/i,
    /joined using this group's invite link/i,
    /security code (with|changed)/i,
  ];
  const filtered = messages.filter(
    m => !systemPatterns.some(p => p.test(m.content)) && m.content.length > 0
  );
  messages.length = 0;
  messages.push(...filtered);

  // Count participants
  const participantMap = new Map<string, { messageCount: number; wordCount: number }>();
  for (const msg of messages) {
    const sender = msg.sender;
    const wc = msg.content.split(/\s+/).filter(Boolean).length;
    if (!participantMap.has(sender)) participantMap.set(sender, { messageCount: 0, wordCount: 0 });
    const p = participantMap.get(sender)!;
    p.messageCount++;
    p.wordCount += wc;
  }

  const participants = Array.from(participantMap.entries())
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.messageCount - a.messageCount);

  const timestamps = messages.map(m => m.timestamp);
  return {
    messages,
    participants,
    dateRange: {
      start: timestamps[0] || "",
      end: timestamps[timestamps.length - 1] || "",
    },
    detectedGroupName,
  };
}

// Generate LLM summary using OpenAI
export async function generateSummary(
  chat: ParsedChat,
  groupName: string
): Promise<SummaryResult> {
  // Truncate if very long (keep last 200 messages for recency)
  const msgsToAnalyze = chat.messages.slice(-200);
  const chatText = msgsToAnalyze
    .map(m => `[${m.timestamp}] ${m.sender}: ${m.content}`)
    .join("\n");

  const prompt = `You are an intelligent WhatsApp group chat analyzer for a legal/business team.

Analyze the following WhatsApp group chat from the group "${groupName}" and produce a structured JSON summary.

Chat Content:
---
${chatText}
---

Participants in this chat: ${chat.participants.map(p => p.name).join(", ")}

Respond ONLY with valid JSON in this exact structure:
{
  "overview": "2-3 sentence summary of what was discussed",
  "keyTopics": ["topic1", "topic2", "topic3"],
  "actionItems": [
    {"text": "action description", "assignee": "person name or 'Team'", "priority": "high|medium|low"}
  ],
  "decisions": ["decision made in chat"],
  "importantMentions": [
    {"person": "name", "context": "why they were mentioned or what they said that was important"}
  ],
  "sentiment": "positive|neutral|negative",
  "topicsForTrend": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
}

Focus on business/legal relevance. Extract action items with clear owners when named. Keep everything concise.`;

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "{}";
    // Extract JSON from response (Claude may wrap it in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch ? jsonMatch[0] : "{}");
    return {
      overview: result.overview || "Summary unavailable.",
      keyTopics: result.keyTopics || [],
      actionItems: result.actionItems || [],
      decisions: result.decisions || [],
      importantMentions: result.importantMentions || [],
      sentiment: result.sentiment || "neutral",
      topicsForTrend: result.topicsForTrend || result.keyTopics || [],
    };
  } catch (err) {
    console.error("LLM error:", err);
    return {
      overview: "Could not generate summary. Check your ANTHROPIC_API_KEY environment variable.",
      keyTopics: [],
      actionItems: [],
      decisions: [],
      importantMentions: [],
      sentiment: "neutral",
      topicsForTrend: [],
    };
  }
}

// Build email HTML report
export function buildEmailReport(data: {
  groups: { name: string; summary: SummaryResult; participants: ParsedChat["participants"] }[];
  reportDate: string;
}): string {
  const groupsHtml = data.groups.map(g => `
    <div style="margin-bottom:32px;border:1px solid #ddd;border-radius:8px;padding:20px;background:#fff">
      <h2 style="color:#01696f;margin:0 0 8px">${g.name}</h2>
      <p style="color:#555;margin:0 0 16px">${g.summary.overview}</p>
      
      ${g.summary.actionItems.length ? `
      <h3 style="font-size:14px;color:#333;margin:0 0 8px">Action Items</h3>
      <ul style="margin:0 0 16px;padding-left:20px">
        ${g.summary.actionItems.map(a => `<li><strong>${a.assignee}:</strong> ${a.text} <span style="color:${a.priority==='high'?'#c0392b':a.priority==='medium'?'#e67e22':'#27ae60'}">[${a.priority}]</span></li>`).join("")}
      </ul>` : ""}
      
      ${g.summary.decisions.length ? `
      <h3 style="font-size:14px;color:#333;margin:0 0 8px">Decisions Made</h3>
      <ul style="margin:0 0 16px;padding-left:20px">
        ${g.summary.decisions.map(d => `<li>${d}</li>`).join("")}
      </ul>` : ""}
      
      <h3 style="font-size:14px;color:#333;margin:0 0 8px">Top Topics</h3>
      <p style="margin:0">${g.summary.keyTopics.map(t => `<span style="background:#e8f4f0;color:#01696f;padding:2px 8px;border-radius:12px;margin-right:4px;font-size:12px">${t}</span>`).join("")}</p>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>WhatsApp Chat Report – ${data.reportDate}</title></head>
<body style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px;background:#f5f5f5;color:#333">
  <div style="background:#01696f;color:#fff;padding:20px 24px;border-radius:8px;margin-bottom:24px">
    <h1 style="margin:0;font-size:22px">WhatsApp Group Intelligence Report</h1>
    <p style="margin:4px 0 0;opacity:0.8;font-size:14px">${data.reportDate} — SANDIVA</p>
  </div>
  ${groupsHtml}
  <p style="font-size:12px;color:#999;text-align:center;margin-top:24px">Generated by WhatsApp Chat Intelligence Dashboard</p>
</body>
</html>`;
}
