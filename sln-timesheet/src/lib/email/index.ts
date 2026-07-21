import { Resend } from "resend";

let _resend: Resend | null = null;

function resend(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

export async function sendEmail(args: { to: string; subject: string; html: string }): Promise<boolean> {
  const client = resend();
  const from = process.env.EMAIL_FROM;
  if (!client || !from) {
    console.warn("Email not configured (RESEND_API_KEY / EMAIL_FROM); skipping:", args.subject);
    return false;
  }
  const { error } = await client.emails.send({ from, to: args.to, subject: args.subject, html: args.html });
  if (error) {
    console.error("Email send failed:", error);
    return false;
  }
  return true;
}

