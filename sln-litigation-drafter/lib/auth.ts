import crypto from "crypto";
import { NextRequest } from "next/server";

// Session tokens are signed and expiring: `v1.<expiresAtMs>.<hmac>` where the
// HMAC is keyed by APP_SESSION_TOKEN (a random secret, never sent to clients).
// Rotating APP_SESSION_TOKEN invalidates every outstanding session at once.
// middleware.ts re-implements verification with Web Crypto for the Edge
// runtime — keep TOKEN_VERSION and the signed payload format in sync.
const TOKEN_VERSION = "v1";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSecret(): string | undefined {
  return process.env.APP_SESSION_TOKEN;
}

function sign(expiresAtMs: number, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`sln-session-${TOKEN_VERSION}:${expiresAtMs}`)
    .digest("hex");
}

export function mintSessionToken(): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const expiresAtMs = Date.now() + SESSION_TTL_SECONDS * 1000;
  return `${TOKEN_VERSION}.${expiresAtMs}.${sign(expiresAtMs, secret)}`;
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const secret = getSecret();
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;

  const expiresAtMs = Number(parts[1]);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;

  try {
    const expected = Buffer.from(sign(expiresAtMs, secret), "hex");
    const provided = Buffer.from(parts[2], "hex");
    if (provided.length === 0 || provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

// Constant-time string comparison that doesn't leak length: compare digests.
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function getSessionFromRequest(req: NextRequest): string | undefined {
  return req.cookies.get("sln_session")?.value;
}

export function isAuthenticatedRequest(req: NextRequest): boolean {
  return isValidSession(getSessionFromRequest(req));
}
