"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { EntryRow, type EntryRowData } from "@/components/entry-row";

export function TimesheetList({ entries }: { entries: EntryRowData[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(entries.filter((e) => e.status === "draft").map((e) => e.id)),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const days = useMemo(() => {
    const map = new Map<string, EntryRowData[]>();
    for (const e of entries) {
      (map.get(e.date) ?? map.set(e.date, []).get(e.date)!).push(e);
    }
    return [...map.entries()];
  }, [entries]);

  const chosen = entries.filter((e) => e.status === "draft" && selected.has(e.id));
  const chosenUnits = chosen.reduce((s, e) => s + Number(e.units), 0);
  const routesTo = [...new Set(chosen.map((e) => e.partnerInitials))];

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function remove(id: number) {
    const res = await fetch(`/api/entries/${id}`, { method: "DELETE" });
    if (res.ok) {
      setToast("Draft entry deleted");
      router.refresh();
    }
  }

  async function submit() {
    if (!chosen.length) return;
    setBusy(true);
    const res = await fetch("/api/entries/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: chosen.map((e) => e.id) }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) {
      setToast(`${data.submitted} ${data.submitted === 1 ? "entry" : "entries"} submitted to ${data.routedTo.join(", ")}`);
      setSelected(new Set());
      router.refresh();
    } else {
      setToast(data.error ?? "Submit failed.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">My timesheet</h2>
          <span className="flex-1" />
          <span className="text-xs text-[var(--text-3)]">{entries.length} entries</span>
        </header>
        {days.map(([date, list]) => (
          <div key={date}>
            <div className="flex justify-between px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
              <span>{date}</span>
              <span className="num">{list.reduce((s, e) => s + Number(e.units), 0).toFixed(2)} units</span>
            </div>
            {list.map((e) => (
              <div key={e.id} className="relative">
                <EntryRow entry={e}>
                  {e.status === "draft" && (
                    <span className="order-last ml-auto flex gap-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(e.id)}
                        onChange={() => toggle(e.id)}
                        aria-label="Select entry for submission"
                        className="h-[18px] w-[18px] accent-[var(--navy)]"
                      />
                      <Link
                        href={`/log-time?edit=${e.id}`}
                        aria-label="Edit draft"
                        className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                      >
                        ✎
                      </Link>
                      <button
                        onClick={() => remove(e.id)}
                        aria-label="Delete draft"
                        className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] text-[var(--text-3)] hover:border-burgundy hover:bg-burgundy hover:text-white"
                      >
                        🗑
                      </button>
                    </span>
                  )}
                </EntryRow>
              </div>
            ))}
          </div>
        ))}
        {entries.length === 0 && <p className="p-4 text-sm text-[var(--text-3)]">No entries yet.</p>}
      </section>

      {chosen.length > 0 && (
        <div className="sticky bottom-20 z-30 flex flex-wrap items-center gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3 shadow-lg md:bottom-4">
          <span className="text-[13.5px]">
            Selected <b>{chosen.length} drafts</b> · <span className="num">{chosenUnits.toFixed(2)} units</span>
            <span className="text-[var(--text-2)]"> · routes to <b>{routesTo.join(", ")}</b></span>
          </span>
          <span className="flex-1" />
          <button onClick={() => setSelected(new Set())} className="rounded-lg border border-[var(--border-strong)] px-2.5 py-1.5 text-xs font-semibold">
            Clear
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-lg bg-[var(--gold)] px-4 py-2 text-sm font-semibold text-[#20200a] hover:brightness-105 disabled:opacity-60"
          >
            {busy ? "Submitting…" : "Submit for approval →"}
          </button>
        </div>
      )}

      {toast && (
        <div
          className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[var(--navy)] px-5 py-3 text-[13.5px] font-semibold text-[#eaf3f7] shadow-xl md:bottom-6"
          onAnimationEnd={() => setToast(null)}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
