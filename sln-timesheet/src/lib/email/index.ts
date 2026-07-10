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

export function resetEmailHtml(name: string, resetUrl: string): string {
  return `
  <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
    <div style="height:4px;background:linear-gradient(90deg,#003D5A,#792C38,#522B4C)"></div>
    <h2 style="color:#003D5A">Reset your Sandiva Timesheets password</h2>
    <p>Hi ${name},</p>
    <p>Click the button below to set a new password. This link expires in 1 hour and can be used once.</p>
    <p style="margin:24px 0"><a href="${resetUrl}" style="background:#B9B400;color:#20200a;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Set new password</a></p>
    <p style="color:#7A909C;font-size:13px">If you didn't request this, you can ignore this email.</p>
  </div>`;
}
