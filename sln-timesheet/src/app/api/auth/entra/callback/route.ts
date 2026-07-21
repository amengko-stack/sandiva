import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { acquireEmailByCode, ENTRA_STATE_COOKIE } from "@/lib/auth/entra";
import { mintSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

function base(req: NextRequest): string {
  return process.env.APP_BASE_URL ?? req.nextUrl.origin;
}

function redirectToLogin(req: NextRequest, error: string): NextResponse {
  const res = NextResponse.redirect(`${base(req)}/login?error=${error}`);
  res.cookies.delete(ENTRA_STATE_COOKIE);
  return res;
}

// Receives Microsoft's redirect after sign-in (?code=...&state=...), verifies
// the CSRF state, exchanges the code for tokens, and mints the SAME session
// cookie the old email/password login used to mint — Entra only replaces how
// that cookie gets issued, not its format or how the rest of the app reads it.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(ENTRA_STATE_COOKIE)?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectToLogin(req, "sign_in_failed");
  }

  let email: string | null = null;
  try {
    email = await acquireEmailByCode(code);
  } catch (err) {
    console.error("Entra token exchange failed:", err);
    return redirectToLogin(req, "sign_in_failed");
  }
  if (!email) return redirectToLogin(req, "sign_in_failed");

  const user = await db().query.users.findFirst({ where: eq(tables.users.email, email) });
  if (!user || !user.active) return redirectToLogin(req, "no_account");

  const token = mintSessionToken(user.id, user.role);
  if (!token) return redirectToLogin(req, "server_error");

  const res = NextResponse.redirect(`${base(req)}/`);
  res.cookies.delete(ENTRA_STATE_COOKIE);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
