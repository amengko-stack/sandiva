import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// /api/cron/cleanup-sessions does its own CRON_SECRET bearer check and must be
// reachable by Vercel's cron invoker, which carries no session cookie.
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/cron/cleanup-sessions",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

// Edge-runtime mirror of lib/auth.ts isValidSession — keep the token format
// (`v1.<expiresAtMs>.<hmac-hex>` signed with APP_SESSION_TOKEN) in sync.
const TOKEN_VERSION = "v1";

async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.APP_SESSION_TOKEN;
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;

  const expiresAtMs = Number(parts[1]);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`sln-session-${TOKEN_VERSION}:${expiresAtMs}`)
  );
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const provided = parts[2];
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

  const sessionCookie = request.cookies.get("sln_session")?.value;
  const authenticated = await isValidSession(sessionCookie);

  if (!authenticated) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Sesi berakhir. Silakan masuk kembali." },
        { status: 401 }
      );
    }
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
