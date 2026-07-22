import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { verifyTeamsToken } from "@/lib/auth/teams";
import { mintSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";
import { jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().min(10).max(8000),
});

// Receives the Entra-issued JWT the Microsoft Teams tab obtained via
// authentication.getAuthToken(), verifies it, and mints the SAME session
// cookie the browser Entra flow mints (src/app/api/auth/entra/callback) —
// Teams only replaces how that cookie gets issued, not its format or how the
// rest of the app reads it.
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request.", 400);

  const email = await verifyTeamsToken(parsed.data.token);
  if (!email) return jsonError("Sign-in token was not accepted.", 401);

  const user = await db().query.users.findFirst({ where: eq(tables.users.email, email) });
  if (!user || !user.active) {
    return NextResponse.json({ error: "no_account" }, { status: 403 });
  }

  const token = mintSessionToken(user.id, user.role);
  if (!token) return jsonError("Server is not configured (APP_SESSION_TOKEN).", 500);

  await db().insert(tables.auditLog).values({
    actorId: user.id,
    action: "teams_sign_in",
    entity: "user",
    entityId: String(user.id),
  });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
