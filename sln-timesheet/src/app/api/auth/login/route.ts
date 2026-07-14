import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { verifyPassword } from "@/lib/auth/password";
import { clearAttempts, isRateLimited, recordAttempt } from "@/lib/auth/rate-limit";
import { mintSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/session";

const bodySchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  }
  const email = parsed.data.email.toLowerCase().trim();

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const limitKey = `${ip}:${email}`;
  if (isRateLimited(limitKey)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in 15 minutes." },
      { status: 429 },
    );
  }
  recordAttempt(limitKey);

  const user = await db().query.users.findFirst({
    where: eq(tables.users.email, email),
  });
  // Uniform error — do not reveal whether the account exists.
  const badCreds = NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
  if (!user || !user.active) return badCreds;
  // Pending invite: no password exists yet. Internal app — a clear message
  // beats enumeration-hardening here.
  if (user.passwordHash === null) {
    return NextResponse.json(
      { error: "Your account isn't activated yet — open the invite link from your admin to set a password." },
      { status: 403 },
    );
  }
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) return badCreds;

  const token = mintSessionToken(user.id, user.role);
  if (!token) {
    return NextResponse.json({ error: "Server is not configured (APP_SESSION_TOKEN)." }, { status: 500 });
  }
  clearAttempts(limitKey);

  const res = NextResponse.json({
    ok: true,
    user: { id: user.id, name: user.name, initials: user.initials, role: user.role },
  });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
