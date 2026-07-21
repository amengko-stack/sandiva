import { NextResponse } from "next/server";
import { buildAuthorizationUrl, ENTRA_STATE_COOKIE, randomState } from "@/lib/auth/entra";

// Must run per-request (mints a fresh CSRF state each time) — without this,
// Next tries to prerender the route at build time and fails on missing env vars.
export const dynamic = "force-dynamic";

// Kicks off the Microsoft sign-in redirect. A random `state` is stashed in a
// short-lived httpOnly cookie and echoed back by Entra on the callback — a
// standard CSRF guard for the OAuth redirect.
export async function GET() {
  const state = randomState();
  const authorizeUrl = await buildAuthorizationUrl(state);

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(ENTRA_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes — long enough for the Microsoft sign-in round trip
  });
  return res;
}
