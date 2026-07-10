"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FEE_TYPE_LABEL } from "@/lib/constants";

interface Client { id: number; clientCode: string; name: string; npwp: string | null; contactPerson: string | null }
interface Matter { id: number; clientId: number; code: string; title: string; feeType: string; currency: string; status: string; partnerInitials: string }
interface Partner { id: number; initials: string; name: string }

const inputCls =
  "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--navy)]";
const labelCls = "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]";

export function ClientsScreen({ clients, matters, partners }: { clients: Client[]; matters: Matter[]; partners: Partner[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<"none" | "client" | "matter">("none");
  const [error, setError] = useState<string | null>(null);

  // Add-client form state
  const [cCode, setCCode] = useState("");
  const [cName, setCName] = useState("");
  const [cNpwp, setCNpwp] = useState("");
  const [cAddr, setCAddr] = useState("");
  const [cContact, setCContact] = useState("");
  // Add-matter form state
  const [mClient, setMClient] = useState<number | "">("");
  const [mCode, setMCode] = useState("");
  const [mTitle, setMTitle] = useState("");
  const [mFee, setMFee] = useState("lump_sum");
  const [mCur, setMCur] = useState("IDR");
  const [mAmount, setMAmount] = useState("");
  const [mPartner, setMPartner] = useState<number | "">("");

  async function addClient() {
    setError(null);
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientCode: cCode, name: cName, npwp: cNpwp || undefined, billingAddress: cAddr || undefined, contactPerson: cContact || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Could not add client.");
    setMode("none");
    setCCode(""); setCName(""); setCNpwp(""); setCAddr(""); setCContact("");
    router.refresh();
  }

  async function addMatter() {
    setError(null);
    if (!mClient || !mPartner) return setError("Pick the client and the engagement partner.");
    const res = await fetch("/api/matters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: mClient,
        matterCode: mCode,
        title: mTitle,
        feeType: mFee,
        currency: mCur,
        feeAmount: mAmount ? Number(mAmount) : undefined,
        engagementPartnerId: mPartner,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Could not add matter.");
    setMode("none");
    setMCode(""); setMTitle(""); setMAmount("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="text-[12.5px] text-[var(--text-2)]">
          Clients were loaded from Prohukum at setup; this app is now the record. One client can hold several ongoing matters.
        </p>
        <span className="flex-1" />
        <button onClick={() => { setMode(mode === "client" ? "none" : "client"); setError(null); }} className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)]">
          + Add client
        </button>
        <button onClick={() => { setMode(mode === "matter" ? "none" : "matter"); setError(null); }} className="rounded-lg bg-[var(--gold)] px-3 py-1.5 text-xs font-semibold text-[#20200a] hover:brightness-105">
          + Add matter
        </button>
      </div>

      {error && <p className="rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">{error}</p>}

      {mode === "client" && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">New client</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className={labelCls}>Client code</label><input className={inputCls} value={cCode} onChange={(e) => setCCode(e.target.value)} placeholder="e.g. 50181" /></div>
            <div><label className={labelCls}>Client name</label><input className={inputCls} value={cName} onChange={(e) => setCName(e.target.value)} placeholder="PT …" /></div>
            <div><label className={labelCls}>NPWP</label><input className={inputCls} value={cNpwp} onChange={(e) => setCNpwp(e.target.value)} /></div>
            <div><label className={labelCls}>Contact person</label><input className={inputCls} value={cContact} onChange={(e) => setCContact(e.target.value)} /></div>
            <div className="sm:col-span-2"><label className={labelCls}>Billing address</label><input className={inputCls} value={cAddr} onChange={(e) => setCAddr(e.target.value)} /></div>
          </div>
          <button onClick={addClient} className="mt-4 rounded-lg bg-[var(--gold)] px-4 py-2 text-sm font-semibold text-[#20200a]">Save client</button>
        </div>
      )}

      {mode === "matter" && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold">New matter</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Client</label>
              <select className={inputCls} value={mClient} onChange={(e) => setMClient(Number(e.target.value))}>
                <option value="">Select client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.clientCode} · {c.name}</option>)}
              </select>
            </div>
            <div><label className={labelCls}>Project number</label><input className={inputCls} value={mCode} onChange={(e) => setMCode(e.target.value)} placeholder="e.g. 50181-01" /></div>
            <div className="sm:col-span-2"><label className={labelCls}>Matter title</label><input className={inputCls} value={mTitle} onChange={(e) => setMTitle(e.target.value)} /></div>
            <div>
              <label className={labelCls}>Fee type</label>
              <select className={inputCls} value={mFee} onChange={(e) => setMFee(e.target.value)}>
                {Object.entries(FEE_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Currency</label>
              <select className={inputCls} value={mCur} onChange={(e) => setMCur(e.target.value)}>
                <option>IDR</option><option>USD</option>
              </select>
            </div>
            <div><label className={labelCls}>Agreed fee (optional, minor units)</label><input type="number" className={inputCls} value={mAmount} onChange={(e) => setMAmount(e.target.value)} /></div>
            <div>
              <label className={labelCls}>Engagement partner (approves + signs)</label>
              <select className={inputCls} value={mPartner} onChange={(e) => setMPartner(Number(e.target.value))}>
                <option value="">Select partner…</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.initials} · {p.name}</option>)}
              </select>
            </div>
          </div>
          <button onClick={addMatter} className="mt-4 rounded-lg bg-[var(--gold)] px-4 py-2 text-sm font-semibold text-[#20200a]">Save matter</button>
        </div>
      )}

      {clients.map((c) => {
        const ms = matters.filter((m) => m.clientId === c.id);
        return (
          <section key={c.id} className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
            <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
              <h2 className="text-sm font-semibold">{c.name}</h2>
              <span className="text-xs text-[var(--text-3)]">Client {c.clientCode} · {ms.length} matter{ms.length === 1 ? "" : "s"}</span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-wider text-[var(--text-3)]">
                    <th className="px-4 py-2">Project</th><th className="px-2 py-2">Matter</th><th className="px-2 py-2">Fee</th><th className="px-2 py-2">Cur</th><th className="px-2 py-2">Partner</th><th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {ms.map((m) => (
                    <tr key={m.id} className={`border-t border-[var(--border)] ${m.status === "closed" ? "opacity-50" : ""}`}>
                      <td className="num px-4 py-2 font-semibold">{m.code}</td>
                      <td className="px-2 py-2">{m.title}</td>
                      <td className="px-2 py-2">{FEE_TYPE_LABEL[m.feeType] ?? m.feeType}</td>
                      <td className="px-2 py-2">{m.currency}</td>
                      <td className="px-2 py-2">
                        <span className="grid h-6 w-6 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-3)] text-[9px] font-bold text-[var(--text-2)]">{m.partnerInitials}</span>
                      </td>
                      <td className="px-2 py-2 capitalize">{m.status}</td>
                    </tr>
                  ))}
                  {ms.length === 0 && <tr><td colSpan={6} className="px-4 py-3 text-[var(--text-3)]">No matters yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
