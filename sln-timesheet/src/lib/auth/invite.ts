import { and, eq, isNull } from "drizzle-orm";
import { db, tables } from "@/db";
import { mintResetToken } from "@/lib/auth/password";
import { inviteEmailHtml, sendEmail } from "@/lib/email";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (password resets stay 1 hour)

/**
 * Issue a set-password link for a user: invalidates any outstanding unused
 * tokens, mints a fresh single-use one, and emails it. The URL is returned so
 * the admin can also copy it and send it over WhatsApp — email delivery is
 * not guaranteed (Resend test domain only delivers to the account owner).
 */
export async function issueInviteLink(user: { id: number; name: string; email: string }): Promise<{
  inviteUrl: string;
  emailSent: boolean;
}> {
  await db()
    .update(tables.passwordResets)
    .set({ usedAt: new Date() })
    .where(and(eq(tables.passwordResets.userId, user.id), isNull(tables.passwordResets.usedAt)));

  const { token, tokenHash } = mintResetToken();
  await db()
    .insert(tables.passwordResets)
    .values({ userId: user.id, tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) });

  const base = process.env.APP_BASE_URL ?? "http://localhost:3100";
  const inviteUrl = `${base}/reset-password?token=${token}&welcome=1`;
  const emailSent = await sendEmail({
    to: user.email,
    subject: "Welcome to Sandiva Timesheets — set your password",
    html: inviteEmailHtml(user.name, inviteUrl),
  });
  return { inviteUrl, emailSent };
}
