"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FEE_TYPE_LABEL } from "@/lib/constants";

interface Matter {
  id: number; code: string; title: string; feeType: string; currency: string;
  status: "active" | "closed"; engagementPartnerId: number; clientName: string;
}
interface Partner { id: number; initials: string; name: string }

export function MattersScreen({
  matters,
  partners,
  budgets = {},
}: {
  matters: Matter[];
  partners: Partner[];
  budgets?: Record<number, { pct: number; level: "amber" | "over" }>;
}) {
  const router = useRouter();
  const [toast, setToast] = useState<string | null>(null);

  async function patch(id: number, body: object, msg: string) {
    const res = await fetch(`/api/matters/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setToast(res.ok ? msg : data.error ?? "Update failed.");
    if (res.ok) router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-card border border-plum/30 bg-plum/5 px-4 py-2.5 text-[12.5px] font-medium text-plum">
        Every matter has one designated <b>engagement partner</b> — that partner approves its time and signs its
        invoices. Closing a matter removes it from the log-time picker; history is retained.
      </p>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-[var(--text-3)]">
                <th className="px-4 py-2.5">Project</th><th className="px-2 py-2.5">Client</th><th className="px-2 py-2.5">Matter</th>
                <th className="px-2 py-2.5">Fee</th><th className="px-2 py-2.5">Cur</th>
                <th className="px-2 py-2.5">Engagement partner</th><th className="px-2 py-2.5">Budget</th><th className="px-2 py-2.5">Status</th><th className="px-2 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {matters.map((m) => (
                <tr key={m.id} className={`border-t border-[var(--border)] ${m.status === "closed" ? "opacity-50" : ""}`}>
                  <td className="num px-4 py-2 font-semibold">{m.code}</td>
                  <td className="max-w-[180px] truncate px-2 py-2">{m.clientName}</td>
                  <td className="max-w-[240px] truncate px-2 py-2">{m.title}</td>
                  <td className="px-2 py-2">{FEE_TYPE_LABEL[m.feeType] ?? m.feeType}</td>
                  <td className="px-2 py-2">{m.currency}</td>
                  <td className="px-2 py-2">
                    <select
                      value={m.engagementPartnerId}
                      onChange={(e) => patch(m.id, { engagementPartnerId: Number(e.target.value) }, `Engagement partner for ${m.code} updated`)}
                      className="rounded-md border border-[var(--border-strong)] bg-[var(--surface)] px-2 py-1 text-xs font-bold"
                    >
                      {partners.map((p) => <option key={p.id} value={p.id}>{p.initials}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2">
                    {budgets[m.id] ? (
                      <span
                        className={`num rounded-full px-2 py-0.5 text-[10.5px] font-bold ${
                          budgets[m.id].level === "over" ? "bg-burgundy/15 text-burgundy" : "bg-[var(--gold-soft)] text-[var(--gold-ink)]"
                        }`}
                        title="Value delivered vs agreed fee"
                      >
                        {budgets[m.id].pct}%
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--text-3)]">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold capitalize ${m.status === "active" ? "bg-good/15 text-good" : "bg-[var(--surface-3)] text-[var(--text-2)]"}`}>
                      {m.status}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    {m.status === "active" ? (
                      <button onClick={() => patch(m.id, { status: "closed" }, `${m.code} closed — no new time can be logged`)} className="rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold hover:border-burgundy hover:text-burgundy">
                        Close
                      </button>
                    ) : (
                      <button onClick={() => patch(m.id, { status: "active" }, `${m.code} reopened`)} className="rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-xs font-semibold hover:bg-[var(--surface-2)]">
                        Reopen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {toast && (
        <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[var(--navy)] px-5 py-3 text-[13.5px] font-semibold text-[#eaf3f7] shadow-xl md:bottom-6">
          {toast}
          <button className="ml-3 text-[#8fb2c2]" onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </div>
  );
}
