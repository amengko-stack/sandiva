import crypto from "crypto";
import { NextRequest } from "next/server";

const SALT = "sln-drafter-2024";

export function hashPassword(password: string): string {
  return crypto
    .createHmac("sha256", SALT)
    .update(password)
    .digest("hex");
}

export function makeSessionToken(password: string): string {
  return hashPassword(password);
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const expected = process.env.APP_SESSION_TOKEN;
  if (!expected) return false;
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    console.error("[auth] session token comparison failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

export function getSessionFromRequest(req: NextRequest): string | undefined {
  return req.cookies.get("sln_session")?.value;
}

export function isAuthenticatedRequest(req: NextRequest): boolean {
  return isValidSession(getSessionFromRequest(req));
}
