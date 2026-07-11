// Draft-reply generator: produces a reply the partner can edit and send.
// LLM-backed when ANTHROPIC_API_KEY is set, category-aware templates otherwise.
import Anthropic from "@anthropic-ai/sdk";
import type { CosMessage } from "@shared/schema";
import { llmAvailable } from "./triage";

const PARTNER_NAME = process.env.COS_PARTNER_NAME || "A. Mengko";

function firstName(sender: string): string {
  const cleaned = sender.replace(/\(.*?\)/g, "").trim();
  return cleaned.split(/\s+/)[0] || "there";
}

export function templateReply(message: CosMessage): string {
  const name = firstName(message.sender);
  const re = message.subject ? `Re: ${message.subject}` : "your message";
  const category = message.category || "internal";

  const bodies: Record<string, string> = {
    client_matter:
      `Dear ${name},\n\nThank you for your message regarding ${re}. I have reviewed it and am giving the matter my immediate attention. I will come back to you with a substantive response and recommended next steps shortly.\n\nIf anything becomes more urgent in the meantime, please call my direct line.`,
    opposing_counsel:
      `Counsel,\n\nWe acknowledge receipt of your correspondence regarding ${re}. We are reviewing it with our client and will respond in due course. Nothing in this message should be construed as an admission or waiver of any of our client's rights or positions, all of which are expressly reserved.`,
    court_notice:
      `Dear ${name},\n\nWe confirm receipt of the notice regarding ${re}. The relevant dates have been calendared and we will comply with the stated requirements. Please direct any further correspondence in this matter to my attention.`,
    internal:
      `Hi ${name},\n\nThanks for flagging this. I've read through it — let's discuss briefly today or tomorrow. Please get 15 minutes on my calendar and bring the latest draft/documents with you.`,
    business_dev:
      `Dear ${name},\n\nThank you for reaching out to the firm regarding ${re}. We would be glad to discuss how we can assist. Before we proceed, we will run our standard conflicts check; my assistant will follow up to schedule an initial consultation.`,
    admin:
      `Hi ${name},\n\nThank you for the information — noted. No further action needed from my side at this time.`,
  };

  return `${bodies[category] || bodies.internal}\n\nBest regards,\n${PARTNER_NAME}`;
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

async function llmReply(message: CosMessage): Promise<string> {
  const prompt = `You are drafting a reply on behalf of ${PARTNER_NAME}, a law firm partner. Write in a professional, measured voice appropriate to the recipient. Do not concede anything to opposing counsel. Keep it under 150 words.

Message to reply to:
From: ${message.sender} (${message.sender_role})
Subject: ${message.subject || "(none)"}
Category: ${message.category || "unknown"}
Body:
${message.body.slice(0, 3000)}

Respond with ONLY the reply text (no preamble), signed "Best regards,\\n${PARTNER_NAME}".`;

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });
  const content = response.content[0].type === "text" ? response.content[0].text : "";
  if (!content.trim()) throw new Error("Empty LLM reply");
  return content.trim();
}

export async function draftReply(message: CosMessage): Promise<string> {
  if (llmAvailable()) {
    try {
      return await llmReply(message);
    } catch (err) {
      console.error("LLM reply failed, using template fallback:", err);
    }
  }
  return templateReply(message);
}
