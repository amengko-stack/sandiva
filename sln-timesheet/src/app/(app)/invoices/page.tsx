import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { priceEntries } from "@/lib/billing/resolve";
import { fmtMoney } from "@/lib/billing/firm";
import { VoidButton } from "./void-button";

export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  const user = (await getCurrentUser())!;
  if (user.role === "member") redirect("/");

  // Approved (unbilled) entries grouped by matter = ready to invoice.
  const approvedRows = await db()
    .select({ id: tables.timeEntries.id, matterId: tables.timeEntries.matterId })
    .from(tables.timeEntries)
    .where(eq(tables.timeEntries.status, "approved"));
  const byMatter = new Map<number, number[]>();
  for (const r of approvedRows as any[]) {
    (byMatter.get(r.matterId) ?? byMatter.set(r.matterId, []).get(r.matterId)!).push(r.id);
  }

  const ready: {
    id: number; code: string; title: string; clientName: string; currency: "IDR" | "USD";
    partnerInitials: string; units: number; amount: number | null; unresolved: boolean; count: number;
  }[] = [];
  for (const [matterId, entryIds] of byMatter) {
    const { matter, entries } = await priceEntries(matterId, entryIds);
    const client = await db().query.clients.findFirst({ where: eq(tables.clients.id, matter.clientId) });
    const partner = await db().query.users.findFirst({ where: eq(tables.users.id, matter.engagementPartnerId) });
    const unresolved = entries.some((e) => e.unresolved && !e.noCharge);
    ready.push({
      id: matter.id,
      code: matter.matterCode,
      title: matter.title,
      clientName: client?.name ?? "",
      currency: matter.currency,
      partnerInitials: partner?.initials ?? "",
      units: entries.reduce((s, e) => s + e.billableUnits, 0),
      amount: unresolved ? null : entries.reduce((s, e) => s + (e.amount ?? 0), 0),
      unresolved,
      count: entries.length,
    });
  }
  ready.sort((a, b) => a.code.localeCompare(b.code));

  const issued = await db()
    .select({
      id: tables.invoices.id,
      no: tables.invoices.accurateInvoiceNo,
      date: tables.invoices.invoiceDate,
      total: tables.invoices.total,
      currency: tables.invoices.currency,
      status: tables.invoices.status,
      matterCode: tables.matters.matterCode,
      clientBlock: tables.invoices.clientBlock,
    })
    .from(tables.invoices)
    .innerJoin(tables.matters, eq(tables.invoices.matterId, tables.matters.id))
    .orderBy(desc(tables.invoices.id))
    .limit(50);

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-card border border-plum/30 bg-plum/5 px-4 py-2.5 text-[12.5px] font-medium text-plum">
        Approved time, grouped by matter, ready to bill. This app renders the detailed client invoice (PDF);
        <b> Accurate</b> is keyed manually from the summary card and owns the official invoice number.
      </p>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Ready to invoice</h2>
          <span className="flex-1" />
          <span className="text-xs text-[var(--text-3)]">{ready.length} matters</span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-[var(--text-3)]">
                <th className="px-4 py-2">Project</th><th className="px-2 py-2">Client / matter</th>
                <th className="px-2 py-2">Partner</th><th className="px-2 py-2 text-right">Units</th>
                <th className="px-2 py-2 text-right">Amount</th><th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {ready.map((r) => (
                <tr key={r.id} className="border-t border-[var(--border)]">
                  <td className="num px-4 py-2.5 font-semibold">{r.code}</td>
                  <td className="px-2 py-2.5">
                    <div>{r.clientName}</div>
                    <div className="text-[11.5px] text-[var(--text-3)]">{r.title}</div>
                  </td>
                  <td className="px-2 py-2.5">
                    <span className="grid h-6 w-6 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-3)] text-[9px] font-bold text-[var(--text-2)]">{r.partnerInitials}</span>
                  </td>
                  <td className="num px-2 py-2.5 text-right">{r.units.toFixed(2)}</td>
                  <td className="num px-2 py-2.5 text-right">
                    {r.unresolved ? <span className="font-semibold text-burgundy">rate missing</span> : fmtMoney(r.amount ?? 0, r.currency)}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <Link href={`/invoices/new?matter=${r.id}`} className="rounded-lg bg-[var(--gold)] px-3 py-1.5 text-xs font-semibold text-[#20200a] hover:brightness-105">
                      Prepare invoice →
                    </Link>
                  </td>
                </tr>
              ))}
              {ready.length === 0 && <tr><td colSpan={6} className="px-4 py-4 text-[var(--text-3)]">No approved time waiting to be billed.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <header className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Issued invoices</h2>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <tbody>
              {issued.map((inv: any) => (
                <tr key={inv.id} className={`border-t border-[var(--border)] ${inv.status === "void" ? "opacity-50" : ""}`}>
                  <td className="px-4 py-2.5 font-semibold">{inv.no}</td>
                  <td className="num px-2 py-2.5">{inv.matterCode}</td>
                  <td className="px-2 py-2.5 text-[var(--text-3)]">{(inv.clientBlock as any)?.name}</td>
                  <td className="num px-2 py-2.5">{inv.date}</td>
                  <td className="num px-2 py-2.5 text-right font-semibold">{fmtMoney(Number(inv.total), inv.currency)}</td>
                  <td className="px-2 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold capitalize ${inv.status === "issued" ? "bg-plum/15 text-plum" : "bg-[var(--surface-3)] text-[var(--text-2)]"}`}>{inv.status}</span>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <span className="inline-flex gap-2">
                      <Link href={`/invoices/${inv.id}`} className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--surface-2)]">Open</Link>
                      {user.role === "admin" && inv.status === "issued" && <VoidButton id={inv.id} />}
                    </span>
                  </td>
                </tr>
              ))}
              {issued.length === 0 && <tr><td className="px-4 py-4 text-[var(--text-3)]">No invoices issued yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
