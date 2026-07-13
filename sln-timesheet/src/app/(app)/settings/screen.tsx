"use client";

import { useState } from "react";
import type { BankAccount, FirmProfile } from "@/lib/billing/firm";

const inputCls =
  "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--navy)]";
const labelCls = "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]";

export function SettingsScreen({
  firm,
  settings,
}: {
  firm: FirmProfile;
  settings: { defaultPpnRate: number; fxRateUsdIdr: number | null; roundingRule: string };
}) {
  const [f, setF] = useState(firm);
  const [ppn, setPpn] = useState(String(settings.defaultPpnRate));
  const [fx, setFx] = useState(settings.fxRateUsdIdr ? String(settings.fxRateUsdIdr) : "");
  const [rounding, setRounding] = useState(settings.roundingRule);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setBank(i: number, patch: Partial<BankAccount>) {
    setF({ ...f, bankAccounts: f.bankAccounts.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  }
  function addBank() {
    setF({ ...f, bankAccounts: [...f.bankAccounts, { label: "", accountName: f.name, accountNo: "", bankName: "", swift: "" }] });
  }
  function removeBank(i: number) {
    if (f.bankAccounts.length <= 1) return;
    setF({ ...f, bankAccounts: f.bankAccounts.filter((_, j) => j !== i) });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defaultPpnRate: Number(ppn) || 11,
        fxRateUsdIdr: fx ? Number(fx) : null,
        roundingRule: rounding,
        firmProfile: f,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    setMsg(res.ok ? "Settings saved." : data.error ?? "Save failed.");
  }

  return (
    <div className="flex max-w-[680px] flex-col gap-4">
      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
        <h2 className="mb-1 text-sm font-semibold">Firm profile</h2>
        <p className="mb-3 text-xs text-[var(--text-3)]">Appears on every invoice PDF.</p>
        <div className="grid gap-3">
          <div><label className={labelCls}>Firm name</label><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><label className={labelCls}>Address (one line per row)</label>
            <textarea className={`${inputCls} min-h-[70px]`} value={f.addressLines.join("\n")} onChange={(e) => setF({ ...f, addressLines: e.target.value.split("\n").filter(Boolean) })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>NPWP</label><input className={inputCls} value={f.npwp} onChange={(e) => setF({ ...f, npwp: e.target.value })} /></div>
            <div><label className={labelCls}>Phone</label><input className={inputCls} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          </div>
          <div><label className={labelCls}>Accounting email</label><input className={inputCls} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        </div>
      </section>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Bank accounts</h2>
          <span className="text-xs text-[var(--text-3)]">the issuer picks one per invoice</span>
          <span className="flex-1" />
          <button onClick={addBank} className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--surface-2)]">
            + Add account
          </button>
        </div>
        <div className="flex flex-col gap-3">
          {f.bankAccounts.map((b, i) => (
            <div key={i} className="rounded-lg border border-[var(--border)] p-3">
              <div className="mb-2 flex items-center gap-2">
                <input
                  className={`${inputCls} max-w-[220px] font-semibold`}
                  value={b.label}
                  onChange={(e) => setBank(i, { label: e.target.value })}
                  placeholder="Label (e.g. IDR Account)"
                />
                <span className="flex-1" />
                {f.bankAccounts.length > 1 && (
                  <button onClick={() => removeBank(i)} className="rounded-md border border-[var(--border-strong)] px-2 py-1 text-xs font-semibold hover:border-burgundy hover:text-burgundy">
                    Remove
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Account name</label><input className={inputCls} value={b.accountName} onChange={(e) => setBank(i, { accountName: e.target.value })} /></div>
                <div><label className={labelCls}>Account number</label><input className={inputCls} value={b.accountNo} onChange={(e) => setBank(i, { accountNo: e.target.value })} /></div>
                <div><label className={labelCls}>Bank</label><input className={inputCls} value={b.bankName} onChange={(e) => setBank(i, { bankName: e.target.value })} /></div>
                <div><label className={labelCls}>SWIFT</label><input className={inputCls} value={b.swift} onChange={(e) => setBank(i, { swift: e.target.value })} /></div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold">Billing rules</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls}>PPN (VAT) default %</label>
            <input type="number" step="0.5" className={inputCls} value={ppn} onChange={(e) => setPpn(e.target.value)} />
            <p className="mt-1 text-[11px] text-[var(--text-3)]">Check the current rate (11% / 12%) — regulatory currency.</p>
          </div>
          <div>
            <label className={labelCls}>Unit rounding</label>
            <select className={inputCls} value={rounding} onChange={(e) => setRounding(e.target.value)}>
              <option value="2dp">2 decimals (0.01)</option>
              <option value="6min">Round up to 0.1 (6 min)</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>FX USD→IDR (reports only)</label>
            <input type="number" className={inputCls} value={fx} onChange={(e) => setFx(e.target.value)} placeholder="e.g. 16300" />
          </div>
        </div>
      </section>

      {msg && <p className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[13px] font-medium">{msg}</p>}
      <button onClick={save} disabled={busy} className="w-fit rounded-lg bg-[var(--gold)] px-5 py-2.5 font-semibold text-[#20200a] hover:brightness-105 disabled:opacity-60">
        {busy ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}
