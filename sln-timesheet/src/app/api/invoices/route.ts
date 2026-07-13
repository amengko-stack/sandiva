import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { priceEntries, type PricedEntry } from "@/lib/billing/resolve";
import { getFirmProfile } from "@/lib/billing/firm";
import { ppnAmount } from "@/lib/rates";

const bodySchema = z.object({
  // One or several matters. Combined invoices require the same client, the
  // same currency and the SAME engagement partner (one signatory).
  matterIds: z.array(z.number().int().positive()).min(1).max(20),
  entryIds: z.array(z.number().int().positive()).min(1).max(1000),
  disbursementIds: z.array(z.number().int().positive()).max(200).default([]),
  ppnRate: z.number().min(0).max(30),
  accurateInvoiceNo: z.string().trim().min(3, "Enter the invoice number from Accurate.").max(80),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Index into the firm's bank accounts to print on this invoice (default 0).
  bankAccountIndex: z.number().int().min(0).max(20).default(0),
});

export async function POST(req: NextRequest) {
  const auth = requireSession(["partner", "admin", "accounting"]);
  if (!auth.ok) return auth.response;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid invoice.");
  const d = parsed.data;

  const matters = await db().select().from(tables.matters).where(inArray(tables.matters.id, d.matterIds));
  if (matters.length !== d.matterIds.length) return jsonError("Some matters were not found.");

  // Combined-invoice invariants.
  const clientIds = new Set(matters.map((m: any) => m.clientId));
  if (clientIds.size > 1) return jsonError("A combined invoice can only cover matters of ONE client.");
  const currencies = new Set(matters.map((m: any) => m.currency));
  if (currencies.size > 1) return jsonError("All matters on one invoice must bill in the same currency.");
  const partnerIds = new Set(matters.map((m: any) => m.engagementPartnerId));
  if (partnerIds.size > 1)
    return jsonError(
      "These matters have different engagement partners — one invoice has one signatory. Invoice them separately.",
    );

  const client = await db().query.clients.findFirst({ where: eq(tables.clients.id, matters[0].clientId) });
  const partner = await db().query.users.findFirst({ where: eq(tables.users.id, matters[0].engagementPartnerId) });
  if (!client || !partner) return jsonError("Missing client or engagement partner.", 500);
  const currency = matters[0].currency as "IDR" | "USD";
  const matterById = new Map(matters.map((m: any) => [m.id, m]));

  // Price per matter (rates can differ by matter via overrides).
  const priced: (PricedEntry & { matterCode: string })[] = [];
  for (const m of matters as any[]) {
    const { entries } = await priceEntries(m.id, d.entryIds);
    for (const e of entries) priced.push({ ...e, matterCode: m.matterCode });
  }
  if (priced.length !== d.entryIds.length)
    return jsonError("Some entries do not belong to the selected matters.");

  const statuses = await db()
    .select({ id: tables.timeEntries.id, status: tables.timeEntries.status })
    .from(tables.timeEntries)
    .where(inArray(tables.timeEntries.id, d.entryIds));
  if (statuses.some((e: any) => e.status !== "approved"))
    return jsonError("Only approved entries can be invoiced — refresh and retry.");

  const unresolved = priced.filter((e) => e.unresolved && !e.noCharge);
  if (unresolved.length)
    return jsonError(
      `No ${currency} rate for: ${[...new Set(unresolved.map((e) => e.lawyerName))].join(", ")}. Set rates in Users & rates first.`,
    );

  const disbursements = d.disbursementIds.length
    ? await db().select().from(tables.disbursements).where(inArray(tables.disbursements.id, d.disbursementIds))
    : [];
  for (const disb of disbursements as any[]) {
    if (!matterById.has(disb.matterId)) return jsonError("A disbursement belongs to a matter not on this invoice.");
    if (disb.invoiceId) return jsonError("A disbursement is already on another invoice.");
  }

  const feeSubtotal = priced.reduce((s, e) => s + (e.amount ?? 0), 0);
  const disbTotal = (disbursements as any[]).reduce((s, x) => s + Number(x.amount), 0);
  const subtotal = Math.round((feeSubtotal + disbTotal) * 100) / 100;
  const ppn = ppnAmount(subtotal, d.ppnRate);
  const total = Math.round((subtotal + ppn) * 100) / 100;

  const combined = matters.length > 1;
  const matterCodes = matters.map((m: any) => m.matterCode).sort();

  const firm = await getFirmProfile();
  const bankAccount = firm.bankAccounts[d.bankAccountIndex] ?? firm.bankAccounts[0];

  const [invoice] = await db()
    .insert(tables.invoices)
    .values({
      matterId: combined ? null : matters[0].id,
      clientId: client.id,
      accurateInvoiceNo: d.accurateInvoiceNo,
      invoiceDate: d.invoiceDate,
      dueDate: d.dueDate,
      clientBlock: {
        name: client.name,
        address: client.billingAddress,
        up: combined ? client.contactPerson : (matters[0].up ?? client.contactPerson),
        npwp: client.npwp,
        clientCode: client.clientCode,
        matterCode: matterCodes.join(", "),
        matterTitle: combined
          ? `${matters.length} matters — ${matterCodes.join(", ")}`
          : matters[0].title,
      },
      currency,
      subtotal: subtotal.toFixed(2),
      ppnRate: d.ppnRate.toFixed(2),
      ppnAmount: ppn.toFixed(2),
      total: total.toFixed(2),
      signatory: { name: partner.name, title: partner.title ?? "Partner", initials: partner.initials },
      bankAccount,
      status: "issued",
      issuedBy: auth.session.userId,
    })
    .returning();

  priced.sort((a, b) => a.matterCode.localeCompare(b.matterCode) || a.date.localeCompare(b.date) || a.id - b.id);
  for (const e of priced) {
    await db().insert(tables.invoiceLines).values({
      invoiceId: invoice.id,
      kind: "fee",
      matterCode: e.matterCode,
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
      matterCode: (matterById.get(x.matterId) as any).matterCode,
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
    after: { accurateInvoiceNo: d.accurateInvoiceNo, total, entries: d.entryIds.length, matters: matterCodes },
  });

  return NextResponse.json({ ok: true, invoiceId: invoice.id });
}
