import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

const bodySchema = z.object({
  matterId: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().min(3).max(500),
  amount: z.number().positive(),
});

// Disbursements are recorded by partners/admins in the matter's currency.
export async function POST(req: NextRequest) {
  const auth = requireSession(["partner", "admin"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid disbursement.");

  const matter = await db().query.matters.findFirst({ where: eq(tables.matters.id, parsed.data.matterId) });
  if (!matter) return jsonError("Matter not found.", 404);

  const [row] = await db()
    .insert(tables.disbursements)
    .values({
      matterId: matter.id,
      date: parsed.data.date,
      description: parsed.data.description,
      amount: String(Math.round(parsed.data.amount)),
      currency: matter.currency, // always the matter's currency
    })
    .returning();

  return NextResponse.json({ ok: true, disbursement: row });
}
