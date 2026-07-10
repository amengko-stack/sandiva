import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  "/reset-password",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/request-reset",
  "/api/auth/reset-password",
  "/api/cron", // cron routes do their own CRON_SECRET bearer check
  "/manifest.json",
];

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

  // Forward the pathname so server layouts can enforce path-aware rules
  // (e.g. the forced password change redirect in (app)/layout.tsx).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
