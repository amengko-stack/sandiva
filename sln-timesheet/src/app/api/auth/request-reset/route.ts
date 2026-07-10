import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { mintResetToken } from "@/lib/auth/password";
import { isRateLimited, recordAttempt } from "@/lib/auth/rate-limit";
import { resetEmailHtml, sendEmail } from "@/lib/email";

const bodySchema = z.object({ email: z.string().email().max(200) });

// Always responds 200 with the same body — never reveals whether the account exists.
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  const okResponse = NextResponse.json({
    ok: true,
    message: "If that email has an account, a reset link is on its way.",
  });
  if (!parsed.success) return okResponse;

  const email = parsed.data.email.toLowerCase().trim();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limitKey = `reset:${ip}`;
  if (isRateLimited(limitKey)) return okResponse;
  recordAttempt(limitKey);

  const user = await db().query.users.findFirst({ where: eq(tables.users.email, email) });
  if (!user || !user.active) return okResponse;

  const { token, tokenHash } = mintResetToken();
  await db()
    .insert(tables.passwordResets)
    .values({ userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });

  const base = process.env.APP_BASE_URL ?? "http://localhost:3100";
  await sendEmail({
    to: user.email,
    subject: "Reset your Sandiva Timesheets password",
    html: resetEmailHtml(user.name, `${base}/reset-password?token=${token}`),
  });
  return okResponse;
}
