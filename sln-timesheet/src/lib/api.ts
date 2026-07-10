import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/current-user";
import type { Session, Role } from "@/lib/auth/session";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Session for a route handler, or a ready-made 401/403 response. */
export function requireSession(minRoles?: Role[]):
  | { ok: true; session: Session }
  | { ok: false; response: NextResponse } {
  const session = getSession();
  if (!session) return { ok: false, response: jsonError("Session expired. Please sign in again.", 401) };
  if (minRoles && !minRoles.includes(session.role)) {
    return { ok: false, response: jsonError("You don't have access to do that.", 403) };
  }
  return { ok: true, session };
}

/** Today's date (yyyy-mm-dd) in the firm's timezone. */
export function todayJakarta(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}
