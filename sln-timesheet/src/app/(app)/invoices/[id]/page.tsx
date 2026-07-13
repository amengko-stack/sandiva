import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth/current-user";
import { fmtMoney } from "@/lib/billing/firm";

export const dynamic = "force-dynamic";

export default async function InvoiceDetailPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  if (user.role === "member") redirect("/");

  const id = Number(params.id);
  const invoice = await db().query.invoices.findFirst({ where: eq(tables.invoices.id, id) });
  if (!invoice) notFound();
  const lines = await db()
    .select()
    .from(tables.invoiceLines)
    .where(eq(tables.invoiceLines.invoiceId, id))
    .orderBy(asc(tables.invoiceLines.date), asc(tables.invoiceLines.id));

  const cb = invoice.clientBlock as any;
  const sig = invoice.signatory as any;
  const cur = invoice.currency as "IDR" | "USD";
  const fees = (lines as any[]).filter((l) => l.kind === "fee");
  const disb = (lines as any[]).filter((l) => l.kind === "disbursement");
  const feeUnits = fees.reduce((s, l) => s + Number(l.units ?? 0), 0);
  const combined = new Set(fees.map((l: any) => l.matterCode).filter(Boolean)).size > 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/invoices" className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)]">← Invoices</Link>
        <h2 className="text-[15px] font-semibold">{invoice.accurateInvoiceNo}</h2>
        {invoice.status === "void" && <span className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10.5px] font-bold uppercase text-[var(--text-2)]">void</span>}
        <span className="flex-1" />
        <a href={`/api/invoices/${id}/pdf`} className="rounded-lg bg-[var(--gold)] px-3 py-1.5 text-xs font-semibold text-[#20200a] hover:brightness-105">
          ⬇ Download PDF
        </a>
      </div>

      <div className="mx-auto w-full max-w-[760px] overflow-hidden rounded-card border border-[var(--border)] bg-white text-[#101f28] shadow-sm">
        <div className="flex h-9 items-center bg-gradient-to-r from-[#003D5A] via-[#792C38] to-[#522B4C] px-5">
          <span className="text-xs font-semibold tracking-[0.5em] text-white">INVOICE</span>
        </div>
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="max-w-[60%] text-[11px] leading-relaxed text-[#3a4a54]">
              <b className="text-[#101f28]">Menara Rajawali 12th Floor, Mega Kuningan Lot #5.1</b>
              <br />Jl. DR. Ide Anak Agung Gde Agung Str., East Kuningan, Setiabudi (12950), South Jakarta
              <br />Email: Accounting@legal.sandiva.co · Phone: (021) 57950593
            </div>
            <span className="bg-gradient-to-r from-[#003D5A] to-[#792C38] bg-clip-text text-xl font-semibold uppercase tracking-[0.34em] text-transparent">Sandiva</span>
          </div>

          <div className="mt-5 grid gap-3 text-xs sm:grid-cols-2">
            <div className="space-y-1">
              <div className="flex gap-2"><span className="min-w-[100px] text-[#6a7a84]">Customer</span><span>{cb.name}</span></div>
              {cb.address && <div className="flex gap-2"><span className="min-w-[100px] text-[#6a7a84]">Address</span><span>{cb.address}</span></div>}
              {cb.up && <div className="flex gap-2"><span className="min-w-[100px] text-[#6a7a84]">UP</span><span>{cb.up}</span></div>}
            </div>
            <div className="space-y-1">
              <div className="flex gap-2"><span className="min-w-[110px] text-[#6a7a84]">Invoice Date</span><span className="num">{invoice.invoiceDate}</span></div>
              <div className="flex gap-2"><span className="min-w-[110px] text-[#6a7a84]">Due</span><span className="num">{invoice.dueDate}</span></div>
              <div className="flex gap-2"><span className="min-w-[110px] text-[#6a7a84]">Invoice Number</span><span>{invoice.accurateInvoiceNo}</span></div>
              <div className="flex gap-2"><span className="min-w-[110px] text-[#6a7a84]">Client / Project</span><span className="num">{cb.clientCode} / {cb.matterCode}</span></div>
            </div>
          </div>

          <p className="mt-4 text-right text-[12.5px] font-bold">Matter : {cb.matterTitle}</p>
          <div className="mt-1 rounded-sm bg-gradient-to-r from-[#003D5A] to-[#3a2230] px-3 py-1 text-right text-[10.5px] font-bold uppercase tracking-[0.24em] text-white">Attorney&apos;s Fees</div>
          <table className="mt-2 w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                {[...(combined ? ["Matter"] : []), "Date", "Service Description", "Lawyer", "Rate / Unit", "Units", "Amount"].map((h) => (
                  <th key={h} className="border border-[#dbe3e8] bg-[#f3f6f8] px-2 py-1.5 text-left text-[10px] uppercase tracking-wide text-[#41535d]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fees.map((l: any) => (
                <tr key={l.id}>
                  {combined && <td className="num border border-[#e4eaee] px-2 py-1.5 align-top font-semibold">{l.matterCode}</td>}
                  <td className="num border border-[#e4eaee] px-2 py-1.5 align-top">{l.date}</td>
                  <td className="border border-[#e4eaee] px-2 py-1.5 align-top">{l.description}</td>
                  <td className="border border-[#e4eaee] px-2 py-1.5 align-top">{l.lawyerName}</td>
                  <td className="num border border-[#e4eaee] px-2 py-1.5 text-right align-top">{l.rate ? fmtMoney(Number(l.rate), cur) : "—"}</td>
                  <td className="num border border-[#e4eaee] px-2 py-1.5 text-right align-top">{Number(l.units).toFixed(2)}</td>
                  <td className="num border border-[#e4eaee] px-2 py-1.5 text-right align-top">{fmtMoney(Number(l.amount), cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end gap-10 border border-t-0 border-[#dbe3e8] bg-[#fafcfd] px-2.5 py-2 text-xs font-bold">
            <span>SUBTOTAL</span>
            <span className="num">{feeUnits.toFixed(2)}</span>
            <span className="num">{fmtMoney(fees.reduce((s, l: any) => s + Number(l.amount), 0), cur)}</span>
          </div>

          <div className="mt-3 rounded-sm bg-gradient-to-r from-[#003D5A] to-[#3a2230] px-3 py-1 text-right text-[10.5px] font-bold uppercase tracking-[0.24em] text-white">Cost</div>
          {disb.length ? (
            <table className="mt-2 w-full border-collapse text-[11.5px]">
              <tbody>
                {disb.map((l: any) => (
                  <tr key={l.id}>
                    <td className="num border border-[#e4eaee] px-2 py-1.5 w-[90px]">{l.date}</td>
                    <td className="border border-[#e4eaee] px-2 py-1.5">{l.description}</td>
                    <td className="num border border-[#e4eaee] px-2 py-1.5 text-right">{fmtMoney(Number(l.amount), cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-2 border border-[#e4eaee] px-2 py-1.5 text-[11.5px] text-[#8a97a0]">No disbursements for this period.</p>
          )}

          <div className="ml-auto mt-4 w-[260px] text-[12.5px]">
            <div className="flex justify-between border border-[#dbe3e8] px-2.5 py-1.5"><span>Subtotal</span><span className="num">{fmtMoney(Number(invoice.subtotal), cur)}</span></div>
            <div className="flex justify-between border border-t-0 border-[#dbe3e8] px-2.5 py-1.5"><span>VAT (PPN {Number(invoice.ppnRate)}%)</span><span className="num">{fmtMoney(Number(invoice.ppnAmount), cur)}</span></div>
            <div className="flex justify-between border border-t-0 border-[#003D5A] bg-[#003D5A] px-2.5 py-1.5 font-bold text-white"><span>Total</span><span className="num">{fmtMoney(Number(invoice.total), cur)}</span></div>
          </div>

          <div className="mt-6 flex items-end justify-between gap-5">
            <div className="text-[11px] leading-relaxed text-[#3a4a54]">
              <b className="text-[#101f28]">Please remit payment to</b>
              <br />Account Name : Pers Perdata Sandiva Lawyer Network
              <br />Account No. : 1260060600607 (IDR) · Bank Mandiri · BMRIIDJA
            </div>
            <div className="text-center text-xs">
              Sincerely,
              <div className="mt-9 border-t border-[#101f28] pt-1 font-bold">{sig.name}</div>
              <div className="text-[11px] text-[#6a7a84]">{sig.title} · Engagement partner ({sig.initials})</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
