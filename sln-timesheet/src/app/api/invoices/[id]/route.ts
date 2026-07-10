import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession, todayJakarta } from "@/lib/api";

const patchSchema = z.object({ paid: z.boolean() });

// Light AR: mark an invoice collected (Accurate remains the ledger of record).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["partner", "admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(params.id);
  if (!Number.isInteger(id)) return jsonError("Invalid invoice id.");
  const invoice = await db().query.invoices.findFirst({ where: eq(tables.invoices.id, id) });
  if (!invoice) return jsonError("Invoice not found.", 404);
  if (invoice.status === "void") return jsonError("A void invoice cannot be marked paid.");

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Nothing to update.");

  await db()
    .update(tables.invoices)
    .set({ paidAt: parsed.data.paid ? todayJakarta() : null })
    .where(eq(tables.invoices.id, id));

  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: parsed.data.paid ? "invoice_paid" : "invoice_unpaid",
    entity: "invoice",
    entityId: String(id),
    after: { accurateInvoiceNo: invoice.accurateInvoiceNo, paid: parsed.data.paid },
  });

  return NextResponse.json({ ok: true });
}
