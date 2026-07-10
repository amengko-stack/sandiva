"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";

interface RateRow { billingRateIdr: string | null; billingRateUsd: string | null; costRateIdr: string | null; effectiveFrom: string }
interface UserRow {
  id: number; name: string; initials: string; email: string; role: string;
  title: string | null; weeklyTargetUnits: string; active: boolean;
  rate: RateRow | null;
  rateHistory: RateRow[];
}

const inputCls =
  "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--navy)]";
const labelCls = "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]";
const idr = (v: string | null) => (v ? "Rp " + Number(v).toLocaleString("en-US") : "—");
const usd = (v: string | null) => (v ? "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "—");

interface DelegateMapping {
  id: number;
  delegateInitials: string;
  delegateName: string;
  principalInitials: string;
  principalName: string;
}

export function UsersScreen({ users, delegates = [] }: { users: UserRow[]; delegates?: DelegateMapping[] }) {
  const router = useRouter();
  const [dDelegate, setDDelegate] = useState<number | "">("");
  const [dPrincipal, setDPrincipal] = useState<number | "">("");
  const [adding, setAdding] = useState(false);
  const [rateFor, setRateFor] = useState<UserRow | null>(null);
  const [historyFor, setHistoryFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "", initials: "", email: "", password: "", role: "member", title: "",
    weeklyTargetUnits: "40", billingRateIdr: "", billingRateUsd: "", costRateIdr: "",
  });
  const [rate, setRate] = useState({ billingRateIdr: "", billingRateUsd: "", costRateIdr: "", effectiveFrom: "" });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function addUser() {
    setError(null);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name, initials: form.initials, email: form.email, password: form.password,
        role: form.role, title: form.title || undefined, weeklyTargetUnits: Number(form.weeklyTargetUnits) || 40,
        billingRateIdr: form.billingRateIdr ? Number(form.billingRateIdr) : undefined,
        billingRateUsd: form.billingRateUsd ? Number(form.billingRateUsd) : undefined,
        costRateIdr: form.costRateIdr ? Number(form.costRateIdr) : undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Could not add user.");
    setAdding(false);
    router.refresh();
  }

  async function addDelegate() {
    setError(null);
    if (!dDelegate || !dPrincipal) return setError("Pick who logs, and for whom.");
    const res = await fetch("/api/delegates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delegateId: dDelegate, principalId: dPrincipal }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Could not add the mapping.");
    setDDelegate(""); setDPrincipal("");
    router.refresh();
  }

  async function removeDelegate(id: number) {
    const res = await fetch(`/api/delegates?id=${id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  async function toggleActive(u: UserRow) {
    setError(null);
    const res = await fetch(`/api/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !u.active }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Update failed.");
    router.refresh();
  }

  async function addRate() {
    if (!rateFor) return;
    setError(null);
    const res = await fetch(`/api/users/${rateFor.id}/rates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billingRateIdr: rate.billingRateIdr ? Number(rate.billingRateIdr) : null,
        billingRateUsd: rate.billingRateUsd ? Number(rate.billingRateUsd) : null,
        costRateIdr: rate.costRateIdr ? Number(rate.costRateIdr) : null,
        effectiveFrom: rate.effectiveFrom,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Could not add rate.");
    setRateFor(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <p className="text-[12.5px] text-[var(--text-2)]">
          Billing applies per matter currency (IDR or USD). <b className="text-plum">Cost rate</b> is confidential —
          margin only. Rate changes carry an <b>effective date</b>; past entries bill at the rate in force then.
        </p>
        <span className="flex-1" />
        <button onClick={() => setAdding((v) => !v)} className="flex-none rounded-lg bg-[var(--gold)] px-3 py-1.5 text-xs font-semibold text-[#20200a]">
          + Add user
        </button>
      </div>

      {error && <p className="rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">{error}</p>}

      {adding && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">New user</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div><label className={labelCls}>Name</label><input className={inputCls} value={form.name} onChange={set("name")} /></div>
            <div><label className={labelCls}>Initials</label><input className={inputCls} value={form.initials} onChange={set("initials")} placeholder="e.g. RJP" /></div>
            <div><label className={labelCls}>Email</label><input className={inputCls} type="email" value={form.email} onChange={set("email")} /></div>
            <div><label className={labelCls}>Temp password (10+)</label><input className={inputCls} value={form.password} onChange={set("password")} /></div>
            <div>
              <label className={labelCls}>Role</label>
              <select className={inputCls} value={form.role} onChange={set("role")}>
                <option value="member">Member</option><option value="partner">Partner</option><option value="accounting">Accounting</option><option value="admin">Admin</option>
              </select>
            </div>
            <div><label className={labelCls}>Title (signature)</label><input className={inputCls} value={form.title} onChange={set("title")} placeholder="Associate / Partner" /></div>
            <div><label className={labelCls}>Weekly target (units)</label><input className={inputCls} type="number" value={form.weeklyTargetUnits} onChange={set("weeklyTargetUnits")} /></div>
            <div><label className={labelCls}>Billing rate IDR /unit</label><input className={inputCls} type="number" value={form.billingRateIdr} onChange={set("billingRateIdr")} /></div>
            <div><label className={labelCls}>Billing rate USD /unit</label><input className={inputCls} type="number" value={form.billingRateUsd} onChange={set("billingRateUsd")} /></div>
            <div><label className={labelCls}>Cost rate IDR /unit (confidential)</label><input className={inputCls} type="number" value={form.costRateIdr} onChange={set("costRateIdr")} /></div>
          </div>
          <button onClick={addUser} className="mt-4 rounded-lg bg-[var(--gold)] px-4 py-2 text-sm font-semibold text-[#20200a]">Create user</button>
        </div>
      )}

      {rateFor && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">New rate for {rateFor.name} <span className="text-[var(--text-3)]">(history preserved)</span></h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><label className={labelCls}>Billing IDR /unit</label><input className={inputCls} type="number" value={rate.billingRateIdr} onChange={(e) => setRate((r) => ({ ...r, billingRateIdr: e.target.value }))} /></div>
            <div><label className={labelCls}>Billing USD /unit</label><input className={inputCls} type="number" value={rate.billingRateUsd} onChange={(e) => setRate((r) => ({ ...r, billingRateUsd: e.target.value }))} /></div>
            <div><label className={labelCls}>Cost IDR /unit</label><input className={inputCls} type="number" value={rate.costRateIdr} onChange={(e) => setRate((r) => ({ ...r, costRateIdr: e.target.value }))} /></div>
            <div><label className={labelCls}>Effective from</label><input className={inputCls} type="date" value={rate.effectiveFrom} onChange={(e) => setRate((r) => ({ ...r, effectiveFrom: e.target.value }))} /></div>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={addRate} className="rounded-lg bg-[var(--gold)] px-4 py-2 text-sm font-semibold text-[#20200a]">Save rate</button>
            <button onClick={() => setRateFor(null)} className="rounded-lg border border-[var(--border-strong)] px-4 py-2 text-sm font-semibold">Cancel</button>
          </div>
        </div>
      )}

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Delegates</h2>
          <span className="text-xs text-[var(--text-3)]">who may enter time on someone else&apos;s behalf</span>
          <span className="flex-1" />
          <select value={dDelegate} onChange={(e) => setDDelegate(Number(e.target.value) || "")} className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-2 py-1.5 text-xs font-semibold">
            <option value="">Who logs…</option>
            {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.initials} · {u.name}</option>)}
          </select>
          <span className="text-xs text-[var(--text-3)]">for</span>
          <select value={dPrincipal} onChange={(e) => setDPrincipal(Number(e.target.value) || "")} className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-2 py-1.5 text-xs font-semibold">
            <option value="">Whose time…</option>
            {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.initials} · {u.name}</option>)}
          </select>
          <button onClick={addDelegate} className="rounded-lg bg-[var(--gold)] px-3 py-1.5 text-xs font-semibold text-[#20200a]">Add</button>
        </header>
        {delegates.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-4 py-2 text-[13px]">
            <b>{d.delegateInitials}</b> {d.delegateName}
            <span className="text-[var(--text-3)]">logs for</span>
            <b>{d.principalInitials}</b> {d.principalName}
            <span className="flex-1" />
            <button onClick={() => removeDelegate(d.id)} className="rounded-md border border-[var(--border-strong)] px-2 py-0.5 text-xs font-semibold hover:border-burgundy hover:text-burgundy">Remove</button>
          </div>
        ))}
        {delegates.length === 0 && <p className="px-4 py-3 text-[13px] text-[var(--text-3)]">No delegate mappings yet.</p>}
      </section>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-[var(--text-3)]">
                <th className="px-4 py-2.5">Fee earner</th><th className="px-2 py-2.5">Role</th>
                <th className="px-2 py-2.5 text-right">Billing IDR</th><th className="px-2 py-2.5 text-right">Billing USD</th>
                <th className="px-2 py-2.5 text-right text-plum">Cost IDR</th><th className="px-2 py-2.5 text-right">Target</th><th className="px-2 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <Fragment key={u.id}>
                  <tr className={`border-t border-[var(--border)] ${u.active ? "" : "opacity-50"}`}>
                    <td className="px-4 py-2">
                      <span className="mr-2 inline-grid h-6 w-6 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-3)] align-middle text-[9px] font-bold text-[var(--text-2)]">{u.initials}</span>
                      {u.name}
                      {!u.active && <span className="ml-2 rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10px] font-bold uppercase text-[var(--text-3)]">inactive</span>}
                    </td>
                    <td className="px-2 py-2 capitalize">{u.title ?? u.role}</td>
                    <td className="num px-2 py-2 text-right">{idr(u.rate?.billingRateIdr ?? null)}</td>
                    <td className="num px-2 py-2 text-right">{usd(u.rate?.billingRateUsd ?? null)}</td>
                    <td className="num px-2 py-2 text-right font-semibold text-plum">{idr(u.rate?.costRateIdr ?? null)}</td>
                    <td className="num px-2 py-2 text-right">{Number(u.weeklyTargetUnits)}</td>
                    <td className="px-2 py-2 text-right">
                      <span className="inline-flex gap-1.5">
                        <button onClick={() => setHistoryFor(historyFor === u.id ? null : u.id)} className="rounded-md border border-[var(--border-strong)] px-2 py-1 text-xs font-semibold hover:bg-[var(--surface-2)]" title="Rate history">
                          {historyFor === u.id ? "▴" : "▾"} {u.rateHistory.length}
                        </button>
                        <button onClick={() => { setRateFor(u); setError(null); }} className="rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--surface-2)]">
                          New rate
                        </button>
                        <button
                          onClick={() => toggleActive(u)}
                          className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${u.active ? "border-[var(--border-strong)] hover:border-burgundy hover:text-burgundy" : "border-good text-good hover:bg-good/10"}`}
                        >
                          {u.active ? "Deactivate" : "Reactivate"}
                        </button>
                      </span>
                    </td>
                  </tr>
                  {historyFor === u.id && (
                    <tr className="border-t border-[var(--border)] bg-[var(--surface-2)]">
                      <td colSpan={7} className="px-6 py-2">
                        <table className="w-full text-[12px]">
                          <thead>
                            <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)]">
                              <th className="py-1">Effective from</th><th className="py-1 text-right">Billing IDR</th>
                              <th className="py-1 text-right">Billing USD</th><th className="py-1 text-right text-plum">Cost IDR</th>
                            </tr>
                          </thead>
                          <tbody>
                            {u.rateHistory.map((r, i) => (
                              <tr key={i} className={i === 0 ? "font-semibold" : "text-[var(--text-2)]"}>
                                <td className="num py-1">{r.effectiveFrom}{i === 0 && " (current)"}</td>
                                <td className="num py-1 text-right">{idr(r.billingRateIdr)}</td>
                                <td className="num py-1 text-right">{usd(r.billingRateUsd)}</td>
                                <td className="num py-1 text-right text-plum">{idr(r.costRateIdr)}</td>
                              </tr>
                            ))}
                            {u.rateHistory.length === 0 && <tr><td colSpan={4} className="py-1 text-[var(--text-3)]">No rates yet — entries on this user flag as “no rate”.</td></tr>}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
