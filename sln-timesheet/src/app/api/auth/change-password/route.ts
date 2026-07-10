import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, "New password must be at least 10 characters.").max(200),
});

export async function POST(req: NextRequest) {
  const auth = requireSession();
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid request.");

  const user = await db().query.users.findFirst({ where: eq(tables.users.id, auth.session.userId) });
  if (!user || !user.active) return jsonError("Account not found.", 404);

  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    return jsonError("Current password is incorrect.", 403);
  }
  if (parsed.data.newPassword === parsed.data.currentPassword) {
    return jsonError("New password must be different from the current one.");
  }

  await db()
    .update(tables.users)
    .set({ passwordHash: await hashPassword(parsed.data.newPassword), mustChangePassword: false })
    .where(eq(tables.users.id, user.id));

  return NextResponse.json({ ok: true, message: "Password updated." });
}
