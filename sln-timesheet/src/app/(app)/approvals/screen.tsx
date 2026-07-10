"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Matter { id: number; code: string; title: string; currency: string; clientName: string }
interface Entry { id: number; matterId: number; date: string; units: string; workcode: string; description: string; whoName: string; whoInitials: string }

export function ApprovalsScreen({ initials, matters, entries }: { initials: string; matters: Matter[]; entries: Entry[] }) {
  const router = useRouter();
  const [edits, setEdits] = useState<Record<number, { billedUnits: string; noCharge: boolean }>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const edit = (id: number, e: Entry) => edits[id] ?? { billedUnits: Number(e.units).toFixed(2), noCharge: false };

  async function approve(list: Entry[]) {
    setBusy(true);
    const decisions = list.map((e) => {
      const d = edit(e.id, e);
      return { id: e.id, billedUnits: d.noCharge ? null : Number(d.billedUnits), noCharge: d.noCharge };
    });
    const res = await fetch("/api/entries/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setToast(data.error ?? "Approval failed.");
    setToast(
      data.writeDowns > 0
        ? `${data.approved} approved (${data.writeDowns} with write-down)`
        : `${data.approved} ${data.approved === 1 ? "entry" : "entries"} approved`,
    );
    router.refresh();
  }

  async function sendBack(id: number) {
    const note = window.prompt("Reason for sending back (the member sees this):", "");
    if (note === null) return; // cancelled
    const res = await fetch("/api/entries/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, note: note.trim() || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    setToast(res.ok ? "Sent back for revision" : data.error ?? "Failed.");
    if (res.ok) router.refresh();
  }

  const groups = matters
    .map((m) => ({ matter: m, list: entries.filter((e) => e.matterId === m.id) }))
    .filter((g) => g.list.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-card border border-plum/30 bg-plum/5 px-4 py-2.5 text-[12.5px] font-medium text-plum">
        As engagement partner <b>{initials}</b>, you approve time only for <b>your</b> matters. Adjust units
        (write-down) or mark no-charge before approving — actual units are preserved for realization.
      </p>

      {groups.length === 0 && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 text-sm text-[var(--text-3)] shadow-sm">
          Nothing awaiting your approval right now. 🎉
        </div>
      )}

      {groups.map(({ matter, list }) => (
        <section key={matter.id} className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
          <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
            <h2 className="text-sm font-semibold">{matter.code} · {matter.title}</h2>
            <span className="text-xs text-[var(--text-3)]">{matter.clientName} · {matter.currency}</span>
            <span className="flex-1" />
            <button
              onClick={() => approve(list)}
              disabled={busy}
              className="rounded-lg bg-good px-3 py-1.5 text-xs font-semibold text-white hover:brightness-105 disabled:opacity-60"
            >
              Approve all ({list.length})
            </button>
          </header>
          {list.map((e) => {
            const d = edit(e.id, e);
            return (
              <div key={e.id} className="grid gap-3 border-t border-[var(--border)] px-4 py-3 sm:grid-cols-[1fr_auto]">
                <div>
                  <div className="mb-1 flex items-center gap-2 text-[13px]">
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-[var(--navy)] to-[var(--navy-300)] text-[9px] font-bold text-white">
                      {e.whoInitials}
                    </span>
                    <b>{e.whoName}</b>
                    <span className="text-[11.5px] text-[var(--text-3)]">· {e.date} · {e.workcode}</span>
                  </div>
                  <p className="text-[13.5px]">{e.description}</p>
                </div>
                <div className="flex flex-col items-stretch gap-2 sm:min-w-[240px] sm:items-end">
                  <div className="flex items-center gap-2 text-xs text-[var(--text-2)]">
                    units <span className="num line-through opacity-60">{Number(e.units).toFixed(2)}</span> →
                    <input
                      type="number"
                      step="0.25"
                      min="0"
                      value={d.billedUnits}
                      disabled={d.noCharge}
                      onChange={(ev) => setEdits((s) => ({ ...s, [e.id]: { ...d, billedUnits: ev.target.value } }))}
                      className="num w-[80px] rounded-md border border-[var(--border-strong)] bg-[var(--surface)] px-2 py-1.5 text-[13px] disabled:opacity-50"
                    />
                    <label className="flex items-center gap-1.5 font-semibold text-burgundy">
                      <input
                        type="checkbox"
                        checked={d.noCharge}
                        onChange={(ev) => setEdits((s) => ({ ...s, [e.id]: { ...d, noCharge: ev.target.checked } }))}
                      />
                      no-charge
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => sendBack(e.id)} className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1.5 text-xs font-semibold hover:bg-[var(--surface-2)]">
                      Send back
                    </button>
                    <button
                      onClick={() => approve([e])}
                      disabled={busy}
                      className="rounded-lg bg-good px-3 py-1.5 text-xs font-semibold text-white hover:brightness-105 disabled:opacity-60"
                    >
                      Approve
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      ))}

      {toast && (
        <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[var(--navy)] px-5 py-3 text-[13.5px] font-semibold text-[#eaf3f7] shadow-xl md:bottom-6">
          {toast}
          <button className="ml-3 text-[#8fb2c2]" onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </div>
  );
}
