import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";

// Void an invoice (ADMIN only, audited): its entries return to `approved`
// and its disbursements detach, so everything can be re-billed correctly.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(params.id);
  if (!Number.isInteger(id)) return jsonError("Invalid invoice id.");
  const invoice = await db().query.invoices.findFirst({ where: eq(tables.invoices.id, id) });
  if (!invoice) return jsonError("Invoice not found.", 404);
  if (invoice.status === "void") return jsonError("Invoice is already void.");

  await db()
    .update(tables.timeEntries)
    .set({ status: "approved", invoiceId: null, updatedBy: auth.session.userId, updatedAt: new Date() })
    .where(eq(tables.timeEntries.invoiceId, id));
  await db().update(tables.disbursements).set({ invoiceId: null }).where(eq(tables.disbursements.invoiceId, id));
  await db().update(tables.invoices).set({ status: "void" }).where(eq(tables.invoices.id, id));

  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: "invoice_voided",
    entity: "invoice",
    entityId: String(id),
    before: { accurateInvoiceNo: invoice.accurateInvoiceNo, total: invoice.total },
  });

  return NextResponse.json({ ok: true });
}
