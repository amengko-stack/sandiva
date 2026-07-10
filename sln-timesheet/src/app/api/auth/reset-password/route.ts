import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { hashPassword, hashResetToken } from "@/lib/auth/password";

const bodySchema = z.object({
  token: z.string().min(32).max(200),
  password: z.string().min(10, "Password must be at least 10 characters.").max(200),
});

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const tokenHash = hashResetToken(parsed.data.token);
  const reset = await db().query.passwordResets.findFirst({
    where: and(
      eq(tables.passwordResets.tokenHash, tokenHash),
      isNull(tables.passwordResets.usedAt),
      gt(tables.passwordResets.expiresAt, new Date()),
    ),
  });
  if (!reset) {
    return NextResponse.json(
      { error: "This reset link is invalid or has expired. Request a new one." },
      { status: 400 },
    );
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await db().update(tables.users).set({ passwordHash }).where(eq(tables.users.id, reset.userId));
  await db()
    .update(tables.passwordResets)
    .set({ usedAt: new Date() })
    .where(eq(tables.passwordResets.id, reset.id));

  return NextResponse.json({ ok: true, message: "Password updated. You can sign in now." });
}
