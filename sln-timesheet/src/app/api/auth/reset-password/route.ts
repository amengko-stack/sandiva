import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { hashPassword, hashResetToken } from "@/lib/auth/password";
import { mintSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/session";

const bodySchema = z.object({
  token: z.string().min(32).max(200),
  password: z.string().min(10, "Password must be at least 10 characters.").max(200),
});

// Handles both flows that end in "user sets their own password": invite links
// (7-day tokens, account has no password yet) and forgot-password resets
// (1-hour tokens). On success the user is logged in directly — no second
// sign-in step, no forced-change screen.
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const tokenHash = hashResetToken(parsed.data.token);
  const reset = await db().query.passwordResets.findFirst({
    where: and(
      eq(tables.passwordResets.tokenHash, tokenHash),
      isNull(tables.passwordResets.usedAt),
      gt(tables.passwordResets.expiresAt, new Date()),
    ),
  });
  if (!reset) {
    return NextResponse.json(
      { error: "This link is invalid or has expired. Ask your admin for a new one." },
      { status: 400 },
    );
  }

  const user = await db().query.users.findFirst({ where: eq(tables.users.id, reset.userId) });
  if (!user || !user.active) {
    return NextResponse.json(
      { error: "This account is not available. Contact your admin." },
      { status: 400 },
    );
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await db()
    .update(tables.users)
    .set({ passwordHash, mustChangePassword: false })
    .where(eq(tables.users.id, reset.userId));
  await db()
    .update(tables.passwordResets)
    .set({ usedAt: new Date() })
    .where(eq(tables.passwordResets.id, reset.id));

  const token = mintSessionToken(user.id, user.role);
  if (!token) {
    // Session secret missing — password is set, so a normal sign-in still works.
    return NextResponse.json({ ok: true, autoLogin: false });
  }
  const res = NextResponse.json({ ok: true, autoLogin: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
