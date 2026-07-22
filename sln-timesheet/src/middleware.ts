import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  "/teams", // Microsoft Teams tab entry point — no session cookie yet
  "/api/auth/entra", // Entra ID sign-in redirect + OAuth callback — no session cookie yet
  "/api/auth/teams", // Teams tab SSO exchange — how Teams users get a session
  "/api/auth/logout",
  "/api/cron", // cron routes do their own CRON_SECRET bearer check
  "/manifest.json",
  "/api/health", // App Service health-check ping carries no session cookie
];

// CSRF guard: the session cookie is SameSite=None in production (required for
// the Teams tab iframe), so browsers attach it cross-site. Reject mutating
// requests whose Origin doesn't match us. No Origin (curl, cron, server-to-
// server) passes — those can't carry a victim's cookie automatically.
const MUTATING = ["POST", "PATCH", "PUT", "DELETE"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

// Edge-runtime mirror of src/lib/auth/session.ts — keep the token format
// (`v1.<userId>.<role>.<expiresAtMs>.<hmac-hex>`, HMAC over
// `slnts-session-v1:<userId>:<role>:<expiresAtMs>` keyed by APP_SESSION_TOKEN)
// in sync with that file.
const TOKEN_VERSION = "v1";
const ROLES = ["member", "partner", "admin", "accounting"];
const SESSION_COOKIE = "slnts_session";

async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.APP_SESSION_TOKEN;
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== TOKEN_VERSION) return false;

  const userId = Number(parts[1]);
  const role = parts[2];
  const expiresAtMs = Number(parts[3]);
  if (!Number.isInteger(userId) || userId <= 0) return false;
  if (!ROLES.includes(role)) return false;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`slnts-session-${TOKEN_VERSION}:${userId}:${role}:${expiresAtMs}`),
  );
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const provided = parts[4];
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (MUTATING.includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin) {
      let originHost: string | null = null;
      try { originHost = new URL(origin).host; } catch { originHost = null; }
      // Compare against the PUBLIC host the browser addressed, not
      // request.nextUrl.host — behind Azure App Service's proxy the latter can
      // reflect the internal listener, which would reject legitimate
      // same-site requests (Origin is sent on ALL browser POSTs, same-site
      // included).
      const requestHost =
        request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
      if (!originHost || originHost !== requestHost) {
        return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
      }
    }
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE)?.value;
  const authenticated = await isValidSession(sessionCookie);

  if (!authenticated) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Session expired. Please sign in again." }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
