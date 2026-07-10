import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { SESSION_COOKIE, verifySessionToken, type Session } from "./session";

/** Session from the request cookie (server components / route handlers). */
export function getSession(): Session | null {
  return verifySessionToken(cookies().get(SESSION_COOKIE)?.value);
}

/** Full user row for the current session, or null. */
export async function getCurrentUser() {
  const session = getSession();
  if (!session) return null;
  const user = await db().query.users.findFirst({
    where: eq(tables.users.id, session.userId),
  });
  if (!user || !user.active) return null;
  return user;
}
