"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

interface MatterInfo {
  ids: number[]; code: string; title: string; currency: "IDR" | "USD";
  clientName: string; clientCode: string; up: string; partnerName: string; partnerTitle: string;
  combined: boolean;
}
interface Priced {
  id: number; lawyerName: string; date: string; workcode: string; description: string;
  actualUnits: number; billableUnits: number; noCharge: boolean; rate: number | null; amount: number | null; unresolved: boolean;
  matterCode: string;
}
interface Disb { id: number; date: string; description: string; amount: number }

const money = (n: number, c: "IDR" | "USD") =>
  c === "USD" ? "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2 }) : "Rp " + Math.round(n).toLocaleString("en-US");

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 border-t border-[var(--border)] py-1.5 text-[12.5px] first:border-t-0">
      <span className="min-w-[130px] text-[var(--text-3)]">{label}</span>
      <span className="num min-w-0 flex-1 truncate font-semibold">{value}</span>
      <button
        onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        className="flex-none rounded border border-[var(--border-strong)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-2)] hover:bg-[var(--surface-2)]"
      >
        {copied ? "✓" : "copy"}
      </button>
    </div>
  );
}

export function AssembleScreen({
  matter, entries, disbursements, defaultPpn, today, budget = null, bankAccounts = [],
}: {
  matter: MatterInfo; entries: Priced[]; disbursements: Disb[]; defaultPpn: number; today: string;
  budget?: { pct: number; level: "amber" | "over" } | null;
  bankAccounts?: { label: string; accountNo: string }[];
}) {
  const router = useRouter();
  const [selEntries, setSelEntries] = useState<Set<number>>(new Set(entries.map((e) => e.id)));
  const [selDisb, setSelDisb] = useState<Set<number>>(new Set(disbursements.map((d) => d.id)));
  const [ppn, setPpn] = useState(String(defaultPpn));
  const [bankIdx, setBankIdx] = useState(0);
  const [accNo, setAccNo] = useState("");
  const [invDate, setInvDate] = useState(today);
  const [dueDate, setDueDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDisbForm, setShowDisbForm] = useState(false);
  const [disbForm, setDisbForm] = useState({ date: today, description: "", amount: "" });

  const chosen = entries.filter((e) => selEntries.has(e.id));
  const chosenDisb = disbursements.filter((d) => selDisb.has(d.id));
  const unresolved = chosen.filter((e) => e.unresolved && !e.noCharge);

  const totals = useMemo(() => {
    const fees = chosen.reduce((s, e) => s + (e.amount ?? 0), 0);
    const disb = chosenDisb.reduce((s, d) => s + d.amount, 0);
    const subtotal = Math.round((fees + disb) * 100) / 100;
    const ppnAmt = Math.round(subtotal * (Number(ppn) || 0)) / 100;
    return { fees, disb, subtotal, ppnAmt, total: Math.round((subtotal + ppnAmt) * 100) / 100 };
  }, [chosen, chosenDisb, ppn]);

  const units = chosen.reduce((s, e) => s + e.billableUnits, 0);

  async function issue() {
    setError(null);
    if (!accNo.trim()) return setError("Enter the invoice number from Accurate first (finance keys the summary, Accurate assigns the number).");
    if (!chosen.length) return setError("Select at least one entry.");
    if (unresolved.length) return setError("Some selected entries have no rate in the matter's currency.");
    setBusy(true);
    const res = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matterIds: matter.ids,
        entryIds: chosen.map((e) => e.id),
        disbursementIds: chosenDisb.map((d) => d.id),
        ppnRate: Number(ppn) || 0,
        accurateInvoiceNo: accNo.trim(),
        invoiceDate: invDate,
        dueDate,
        bankAccountIndex: bankIdx,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Could not issue the invoice.");
    router.push(`/invoices/${data.invoiceId}`);
    router.refresh();
  }

  async function addDisb() {
    setError(null);
    const res = await fetch("/api/disbursements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matterId: matter.ids[0], date: disbForm.date, description: disbForm.description, amount: Number(disbForm.amount) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Could not add disbursement.");
    setShowDisbForm(false);
    router.refresh();
  }

  const inputCls = "rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--navy)]";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => router.push("/invoices")} className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)]">← Back</button>
        <h2 className="text-[15px] font-semibold">Assemble invoice · {matter.code}</h2>
        <span className="text-xs text-[var(--text-3)]">{matter.clientName} · {matter.currency}</span>
        {budget && (
          <span
            className={`num rounded-full px-2 py-0.5 text-[10.5px] font-bold ${
              budget.level === "over" ? "bg-burgundy/15 text-burgundy" : "bg-[var(--gold-soft)] text-[var(--gold-ink)]"
            }`}
            title="Value delivered vs agreed fee for this matter"
          >
            {budget.level === "over" ? "OVER FEE BUDGET" : "near fee budget"} · {budget.pct}%
          </span>
        )}
      </div>

      {unresolved.length > 0 && (
        <p className="rounded-card border border-burgundy/30 bg-burgundy/5 px-4 py-2.5 text-[13px] font-medium text-burgundy">
          No {matter.currency} rate for: {[...new Set(unresolved.map((e) => e.lawyerName))].join(", ")} — set it in Users &amp; rates, or deselect those entries. Nothing bills at zero.
        </p>
      )}
      {error && <p className="rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="flex flex-col gap-4">
          <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
            <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
              <h3 className="text-sm font-semibold">Attorney&apos;s fees</h3>
              <span className="flex-1" />
              <span className="num text-xs text-[var(--text-3)]">{units.toFixed(2)} units · {money(totals.fees, matter.currency)}</span>
            </header>
            {entries.map((e) => (
              <label key={e.id} className={`flex cursor-pointer flex-wrap items-center gap-2.5 border-t border-[var(--border)] px-4 py-2.5 hover:bg-[var(--surface-2)] ${e.unresolved && !e.noCharge ? "bg-burgundy/5" : ""}`}>
                <input type="checkbox" checked={selEntries.has(e.id)} onChange={() => setSelEntries((s) => { const n = new Set(s); n.has(e.id) ? n.delete(e.id) : n.add(e.id); return n; })} className="h-[16px] w-[16px] accent-[var(--navy)]" />
                {matter.combined && <span className="num flex-none rounded bg-[var(--surface-3)] px-1.5 text-[10.5px] font-bold text-[var(--text-2)]">{e.matterCode}</span>}
                <span className="num text-xs text-[var(--text-3)]">{e.date}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{e.description}</span>
                <span className="text-xs text-[var(--text-3)]">{e.lawyerName}</span>
                <span className="num text-[13px] font-bold">{e.billableUnits.toFixed(2)}</span>
                <span className="num min-w-[90px] text-right text-[13px] font-semibold">
                  {e.noCharge ? <i className="text-[var(--text-3)]">no charge</i> : e.unresolved ? <b className="text-burgundy">no rate</b> : money(e.amount ?? 0, matter.currency)}
                </span>
              </label>
            ))}
          </section>

          <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
            <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
              <h3 className="text-sm font-semibold">Cost (disbursements)</h3>
              <span className="flex-1" />
              <button onClick={() => setShowDisbForm((v) => !v)} className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--surface-2)]">+ Add</button>
            </header>
            {showDisbForm && (
              <div className="flex flex-wrap items-end gap-2.5 border-t border-[var(--border)] px-4 py-3">
                <input type="date" value={disbForm.date} onChange={(e) => setDisbForm((f) => ({ ...f, date: e.target.value }))} className={inputCls} />
                <input placeholder="Description (e.g. court filing fee)" value={disbForm.description} onChange={(e) => setDisbForm((f) => ({ ...f, description: e.target.value }))} className={`${inputCls} min-w-[200px] flex-1`} />
                <input type="number" placeholder={`Amount (${matter.currency})`} value={disbForm.amount} onChange={(e) => setDisbForm((f) => ({ ...f, amount: e.target.value }))} className={`${inputCls} w-[140px]`} />
                <button onClick={addDisb} className="rounded-lg bg-[var(--gold)] px-3 py-2 text-xs font-semibold text-[#20200a]">Save</button>
              </div>
            )}
            {disbursements.map((d) => (
              <label key={d.id} className="flex cursor-pointer items-center gap-2.5 border-t border-[var(--border)] px-4 py-2.5 hover:bg-[var(--surface-2)]">
                <input type="checkbox" checked={selDisb.has(d.id)} onChange={() => setSelDisb((s) => { const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })} className="h-[16px] w-[16px] accent-[var(--navy)]" />
                <span className="num text-xs text-[var(--text-3)]">{d.date}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{d.description}</span>
                <span className="num text-[13px] font-semibold">{money(d.amount, matter.currency)}</span>
              </label>
            ))}
            {disbursements.length === 0 && !showDisbForm && <p className="border-t border-[var(--border)] px-4 py-3 text-[13px] text-[var(--text-3)]">No unbilled disbursements for this matter.</p>}
          </section>
        </div>

        <div className="flex flex-col gap-4">
          <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold">Invoice details</h3>
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">Invoice date</label>
                  <input type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} className={`${inputCls} w-full`} />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">Due date</label>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={`${inputCls} w-full`} />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">PPN rate %</label>
                <input type="number" step="0.5" min="0" value={ppn} onChange={(e) => setPpn(e.target.value)} className={`${inputCls} w-[110px]`} />
              </div>
              {bankAccounts.length > 1 && (
                <div>
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">Remit-to bank account</label>
                  <select value={bankIdx} onChange={(e) => setBankIdx(Number(e.target.value))} className={`${inputCls} w-full`}>
                    {bankAccounts.map((b, i) => (
                      <option key={i} value={i}>{b.label} · {b.accountNo}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">Accurate invoice number</label>
                <input placeholder="e.g. SLN/CTH/INV/50158-01/VII/2026" value={accNo} onChange={(e) => setAccNo(e.target.value)} className={`${inputCls} w-full`} />
                <p className="mt-1 text-[11px] text-[var(--text-3)]">Key the summary below into Accurate, then paste the number it assigns.</p>
              </div>
            </div>
          </section>

          <section className="rounded-card border border-plum/40 bg-gradient-to-b from-[var(--surface)] to-plum/5 p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-plum">Accurate keying summary</h3>
            <p className="mb-2 text-[11px] text-[var(--text-3)]">Type these into Accurate&apos;s sales invoice — totals match the PDF to the {matter.currency === "IDR" ? "rupiah" : "cent"}.</p>
            <CopyRow label="Customer" value={matter.clientName} />
            <CopyRow label="Invoice date" value={invDate} />
            <CopyRow label="Due date" value={dueDate} />
            <CopyRow label={`Jasa Hukum — ${matter.code}`} value={money(totals.fees, matter.currency)} />
            {totals.disb > 0 && <CopyRow label="Disbursements" value={money(totals.disb, matter.currency)} />}
            <CopyRow label={`PPN ${ppn || 0}%`} value={money(totals.ppnAmt, matter.currency)} />
            <CopyRow label="TOTAL" value={money(totals.total, matter.currency)} />
          </section>

          <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex justify-between py-1 text-[13px]"><span>Fees ({units.toFixed(2)} units)</span><span className="num font-semibold">{money(totals.fees, matter.currency)}</span></div>
            <div className="flex justify-between py-1 text-[13px]"><span>Disbursements</span><span className="num font-semibold">{money(totals.disb, matter.currency)}</span></div>
            <div className="flex justify-between py-1 text-[13px]"><span>PPN {ppn || 0}%</span><span className="num font-semibold">{money(totals.ppnAmt, matter.currency)}</span></div>
            <div className="mt-1 flex justify-between border-t border-[var(--border)] pt-2 text-[15px] font-bold"><span>Total</span><span className="num">{money(totals.total, matter.currency)}</span></div>
            <p className="mt-2 text-[11.5px] text-[var(--text-3)]">Signatory: <b>{matter.partnerName}</b> ({matter.partnerTitle}) — engagement partner.</p>
            <button
              onClick={issue}
              disabled={busy || !chosen.length}
              className="mt-3 w-full rounded-lg bg-[var(--gold)] px-4 py-2.5 font-semibold text-[#20200a] hover:brightness-105 disabled:opacity-60"
            >
              {busy ? "Issuing…" : "Issue & mark billed"}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
