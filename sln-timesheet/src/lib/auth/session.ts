import crypto from "crypto";

// Signed, expiring, stateless session tokens — the SLN pattern
// (sln-litigation-drafter/lib/auth.ts) extended to carry user id + role:
//   `v1.<userId>.<role>.<expiresAtMs>.<hmac>`
// The HMAC (keyed by APP_SESSION_TOKEN) covers every field, so id/role cannot
// be tampered with. Rotating APP_SESSION_TOKEN invalidates all sessions.
// middleware.ts re-implements verification with Web Crypto for the Edge
// runtime — keep TOKEN_VERSION and the payload format in sync.

const TOKEN_VERSION = "v1";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const SESSION_COOKIE = "slnts_session";

export type Role = "member" | "partner" | "admin" | "accounting";
const ROLES: Role[] = ["member", "partner", "admin", "accounting"];

export interface Session {
  userId: number;
  role: Role;
  expiresAtMs: number;
}

function getSecret(): string | undefined {
  return process.env.APP_SESSION_TOKEN;
}

function payload(userId: number, role: Role, expiresAtMs: number): string {
  return `slnts-session-${TOKEN_VERSION}:${userId}:${role}:${expiresAtMs}`;
}

function sign(userId: number, role: Role, expiresAtMs: number, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload(userId, role, expiresAtMs)).digest("hex");
}

export function mintSessionToken(userId: number, role: Role): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const expiresAtMs = Date.now() + SESSION_TTL_SECONDS * 1000;
  return `${TOKEN_VERSION}.${userId}.${role}.${expiresAtMs}.${sign(userId, role, expiresAtMs, secret)}`;
}

export function verifySessionToken(token: string | undefined): Session | null {
  if (!token) return null;
  const secret = getSecret();
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== TOKEN_VERSION) return null;

  const userId = Number(parts[1]);
  const role = parts[2] as Role;
  const expiresAtMs = Number(parts[3]);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!ROLES.includes(role)) return null;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;

  try {
    const expected = Buffer.from(sign(userId, role, expiresAtMs, secret), "hex");
    const provided = Buffer.from(parts[4], "hex");
    if (provided.length === 0 || provided.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(expected, provided)) return null;
  } catch {
    return null;
  }
  return { userId, role, expiresAtMs };
}
