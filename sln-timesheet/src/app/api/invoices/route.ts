import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { priceEntries } from "@/lib/billing/resolve";
import { ppnAmount } from "@/lib/rates";

const bodySchema = z.object({
  matterId: z.number().int().positive(),
  entryIds: z.array(z.number().int().positive()).min(1).max(500),
  disbursementIds: z.array(z.number().int().positive()).max(100).default([]),
  ppnRate: z.number().min(0).max(30),
  accurateInvoiceNo: z.string().trim().min(3, "Enter the invoice number from Accurate.").max(80),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// Issue an invoice: server recomputes ALL amounts (never trusts the client),
// snapshots lines + client block + signatory, marks entries billed.
export async function POST(req: NextRequest) {
  const auth = requireSession(["partner", "admin"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid invoice.");
  const d = parsed.data;

  const { matter, entries } = await priceEntries(d.matterId, d.entryIds);
  const client = await db().query.clients.findFirst({ where: eq(tables.clients.id, matter.clientId) });
  const partner = await db().query.users.findFirst({ where: eq(tables.users.id, matter.engagementPartnerId) });
  if (!client || !partner) return jsonError("Matter is missing its client or engagement partner.", 500);

  // Every requested entry must exist, be approved, and price cleanly.
  if (entries.length !== d.entryIds.length) return jsonError("Some entries were not found on this matter.");
  const notApproved = await db()
    .select({ id: tables.timeEntries.id, status: tables.timeEntries.status })
    .from(tables.timeEntries)
    .where(inArray(tables.timeEntries.id, d.entryIds));
  if (notApproved.some((e: any) => e.status !== "approved"))
    return jsonError("Only approved entries can be invoiced — refresh and retry.");
  const unresolved = entries.filter((e) => e.unresolved && !e.noCharge);
  if (unresolved.length)
    return jsonError(
      `No ${matter.currency} rate for: ${[...new Set(unresolved.map((e) => e.lawyerName))].join(", ")}. Set rates in Users & rates first.`,
    );

  const disbursements = d.disbursementIds.length
    ? await db().select().from(tables.disbursements).where(inArray(tables.disbursements.id, d.disbursementIds))
    : [];
  for (const disb of disbursements as any[]) {
    if (disb.matterId !== matter.id) return jsonError("A disbursement belongs to a different matter.");
    if (disb.invoiceId) return jsonError("A disbursement is already on another invoice.");
  }

  const feeSubtotal = entries.reduce((s, e) => s + (e.amount ?? 0), 0);
  const disbTotal = (disbursements as any[]).reduce((s, x) => s + Number(x.amount), 0);
  const subtotal = Math.round((feeSubtotal + disbTotal) * 100) / 100;
  const ppn = ppnAmount(subtotal, d.ppnRate);
  const total = Math.round((subtotal + ppn) * 100) / 100;

  const [invoice] = await db()
    .insert(tables.invoices)
    .values({
      matterId: matter.id,
      accurateInvoiceNo: d.accurateInvoiceNo,
      invoiceDate: d.invoiceDate,
      dueDate: d.dueDate,
      clientBlock: {
        name: client.name,
        address: client.billingAddress,
        up: matter.up ?? client.contactPerson,
        npwp: client.npwp,
        clientCode: client.clientCode,
        matterCode: matter.matterCode,
        matterTitle: matter.title,
      },
      currency: matter.currency,
      subtotal: subtotal.toFixed(2),
      ppnRate: d.ppnRate.toFixed(2),
      ppnAmount: ppn.toFixed(2),
      total: total.toFixed(2),
      signatory: { name: partner.name, title: partner.title ?? "Partner", initials: partner.initials },
      status: "issued",
      issuedBy: auth.session.userId,
    })
    .returning();

  for (const e of entries) {
    await db().insert(tables.invoiceLines).values({
      invoiceId: invoice.id,
      kind: "fee",
      date: e.date,
      description: e.description,
      lawyerName: e.lawyerName,
      rate: e.rate !== null ? e.rate.toFixed(2) : null,
      units: e.billableUnits.toFixed(2),
      amount: (e.amount ?? 0).toFixed(2),
      timeEntryId: e.id,
    });
  }
  for (const x of disbursements as any[]) {
    await db().insert(tables.invoiceLines).values({
      invoiceId: invoice.id,
      kind: "disbursement",
      date: x.date,
      description: x.description,
      amount: Number(x.amount).toFixed(2),
      disbursementId: x.id,
    });
    await db().update(tables.disbursements).set({ invoiceId: invoice.id }).where(eq(tables.disbursements.id, x.id));
  }

  await db()
    .update(tables.timeEntries)
    .set({ status: "billed", invoiceId: invoice.id, updatedBy: auth.session.userId, updatedAt: new Date() })
    .where(inArray(tables.timeEntries.id, d.entryIds));

  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: "invoice_issued",
    entity: "invoice",
    entityId: String(invoice.id),
    after: { accurateInvoiceNo: d.accurateInvoiceNo, total, entries: d.entryIds.length },
  });

  return NextResponse.json({ ok: true, invoiceId: invoice.id });
}
