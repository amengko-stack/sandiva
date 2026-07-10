import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { priceEntries } from "@/lib/billing/resolve";
import { fmtMoney } from "@/lib/billing/firm";
import { VoidButton } from "./void-button";
import { PaidButton } from "./paid-button";

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
    id: number; code: string; title: string; clientId: number; clientName: string; currency: "IDR" | "USD";
    partnerId: number; partnerInitials: string; units: number; amount: number | null; unresolved: boolean; count: number;
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
      clientId: matter.clientId,
      clientName: client?.name ?? "",
      currency: matter.currency,
      partnerId: matter.engagementPartnerId,
      partnerInitials: partner?.initials ?? "",
      units: entries.reduce((s, e) => s + e.billableUnits, 0),
      amount: unresolved ? null : entries.reduce((s, e) => s + (e.amount ?? 0), 0),
      unresolved,
      count: entries.length,
    });
  }
  ready.sort((a, b) => a.code.localeCompare(b.code));

  // Combinable groups: one client, same engagement partner + currency, 2+ matters ready.
  const groupsMap = new Map<string, typeof ready>();
  for (const r of ready) {
    const key = `${r.clientId}:${r.partnerId}:${r.currency}`;
    (groupsMap.get(key) ?? groupsMap.set(key, []).get(key)!).push(r);
  }
  const combinable = [...groupsMap.values()].filter((g) => g.length >= 2 && g.every((r) => !r.unresolved));

  const issued = await db()
    .select({
      id: tables.invoices.id,
      no: tables.invoices.accurateInvoiceNo,
      date: tables.invoices.invoiceDate,
      total: tables.invoices.total,
      currency: tables.invoices.currency,
      status: tables.invoices.status,
      paidAt: tables.invoices.paidAt,
      clientBlock: tables.invoices.clientBlock,
    })
    .from(tables.invoices)
    .orderBy(desc(tables.invoices.id))
    .limit(50);

  // Light AR: outstanding = issued, not void, not paid.
  const outstanding = (issued as any[]).filter((i) => i.status === "issued" && !i.paidAt);
  const outIdr = outstanding.filter((i) => i.currency === "IDR").reduce((s, i) => s + Number(i.total), 0);
  const outUsd = outstanding.filter((i) => i.currency === "USD").reduce((s, i) => s + Number(i.total), 0);

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-card border border-plum/30 bg-plum/5 px-4 py-2.5 text-[12.5px] font-medium text-plum">
        Approved time, grouped by matter, ready to bill. This app renders the detailed client invoice (PDF);
        <b> Accurate</b> is keyed manually from the summary card and owns the official invoice number.
      </p>

      {outstanding.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Outstanding (unpaid)</div>
            <div className="num mt-1 text-[20px] font-bold">
              {outIdr > 0 && fmtMoney(outIdr, "IDR")}
              {outIdr > 0 && outUsd > 0 && " · "}
              {outUsd > 0 && fmtMoney(outUsd, "USD")}
            </div>
            <div className="text-xs text-[var(--text-2)]">{outstanding.length} invoice{outstanding.length === 1 ? "" : "s"} awaiting collection</div>
          </div>
        </div>
      )}

      {combinable.length > 0 && (
        <div className="rounded-card border border-plum/40 bg-plum/5 px-4 py-3">
          {combinable.map((g) => (
            <div key={g[0].clientId + g[0].currency} className="flex flex-wrap items-center gap-2 py-1 text-[13px]">
              <b>{g[0].clientName}</b>
              <span className="text-[var(--text-2)]">
                has {g.length} matters ready ({g.map((r) => r.code).join(", ")}) — same partner &amp; currency
              </span>
              <span className="flex-1" />
              <Link
                href={`/invoices/new?matters=${g.map((r) => r.id).join(",")}`}
                className="rounded-lg bg-plum px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
              >
                Combined invoice →
              </Link>
            </div>
          ))}
        </div>
      )}

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
                  <td className="num px-2 py-2.5">{(inv.clientBlock as any)?.matterCode}</td>
                  <td className="px-2 py-2.5 text-[var(--text-3)]">{(inv.clientBlock as any)?.name}</td>
                  <td className="num px-2 py-2.5">{inv.date}</td>
                  <td className="num px-2 py-2.5 text-right font-semibold">{fmtMoney(Number(inv.total), inv.currency)}</td>
                  <td className="px-2 py-2.5">
                    {inv.status === "void" ? (
                      <span className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10.5px] font-bold text-[var(--text-2)]">void</span>
                    ) : inv.paidAt ? (
                      <span className="num rounded-full bg-good/15 px-2 py-0.5 text-[10.5px] font-bold text-good" title={`Paid ${inv.paidAt}`}>paid</span>
                    ) : (
                      <span className="rounded-full bg-plum/15 px-2 py-0.5 text-[10.5px] font-bold text-plum">unpaid</span>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <span className="inline-flex gap-2">
                      <Link href={`/invoices/${inv.id}`} className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--surface-2)]">Open</Link>
                      {inv.status === "issued" && <PaidButton id={inv.id} paid={!!inv.paidAt} />}
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
