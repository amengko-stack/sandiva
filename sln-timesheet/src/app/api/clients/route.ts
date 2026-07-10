import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const bodySchema = z.object({
  clientCode: z.string().trim().min(1).max(20).regex(/^[0-9A-Za-z-]+$/, "Client code: digits/letters only."),
  name: z.string().trim().min(2).max(200),
  npwp: z.string().trim().max(40).optional(),
  billingAddress: z.string().trim().max(500).optional(),
  contactPerson: z.string().trim().max(120).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
});

export async function POST(req: NextRequest) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid client.");

  const existing = await db().query.clients.findFirst({
    where: eq(tables.clients.clientCode, parsed.data.clientCode),
  });
  if (existing) return jsonError(`Client code ${parsed.data.clientCode} already exists (${existing.name}).`);

  const [client] = await db()
    .insert(tables.clients)
    .values({ ...parsed.data, email: parsed.data.email || null })
    .returning();
  return NextResponse.json({ ok: true, client });
}
