"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WORKCODES } from "@/lib/constants";

export interface EditEntry {
  id: number;
  matterId: number;
  matterLabel: string;
  date: string;
  units: number;
  workcode: string;
  description: string;
}

interface MatterOption {
  id: number;
  code: string;
  title: string;
  feeType: string;
  currency: string;
  clientName: string;
  partnerInitials: string;
  partnerName: string;
  mine: boolean;
}

const QUICK_UNITS = [0.25, 0.5, 1, 2, 4];

export function LogTimeForm({ today, edit }: { today: string; edit: EditEntry | null }) {
  const router = useRouter();
  const [matterId, setMatterId] = useState<number | null>(edit?.matterId ?? null);
  const [search, setSearch] = useState(edit?.matterLabel ?? "");
  const [options, setOptions] = useState<MatterOption[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MatterOption | null>(null);
  const [date, setDate] = useState(edit?.date ?? today);
  const [units, setUnits] = useState(edit ? String(edit.units) : "");
  const [workcode, setWorkcode] = useState(edit?.workcode ?? WORKCODES[0]);
  const [description, setDescription] = useState(edit?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  function queryMatters(q: string) {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      const res = await fetch(`/api/matters/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        setOptions(data.matters);
        setOpen(true);
      }
    }, 150);
  }

  function pick(m: MatterOption) {
    setMatterId(m.id);
    setSelected(m);
    setSearch(`${m.code} · ${m.clientName}`);
    setOpen(false);
  }

  async function save() {
    setError(null);
    if (!matterId) return setError("Search and select a matter first.");
    const u = parseFloat(units);
    if (!u || u <= 0) return setError("Enter a Unit value (1 unit = 1 hour).");
    if (description.trim().length < 3) return setError("Add a description — it appears on the client invoice.");
    setBusy(true);
    const payload = { matterId, date, units: u, workcode, description: description.trim() };
    const res = edit
      ? await fetch(`/api/entries/${edit.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      : await fetch("/api/entries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Could not save the entry.");
    router.push("/timesheet");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-[640px] rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
      <header className="border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold">{edit ? "Edit draft entry" : "Log time"}</h2>
      </header>
      <div className="flex flex-col gap-4 p-4">
        <div ref={boxRef} className="relative">
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">Matter</label>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setMatterId(null);
              setSelected(null);
              queryMatters(e.target.value);
            }}
            onFocus={() => queryMatters(search)}
            placeholder="Search by project number, client, or matter…"
            className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-base outline-none focus:border-[var(--navy)] focus:ring-2 focus:ring-[var(--navy)]/20"
          />
          {open && (
            <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-[300px] overflow-auto rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] shadow-lg">
              {options.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => pick(m)}
                  className="flex w-full items-center gap-3 border-t border-[var(--border)] px-3 py-2.5 text-left first:border-t-0 hover:bg-[var(--surface-2)]"
                >
                  <span className="num min-w-[74px] flex-none text-[13px] font-bold">{m.code}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{m.title}</span>
                    <span className="block truncate text-[11.5px] text-[var(--text-3)]">
                      {m.clientName} · approval: {m.partnerInitials}
                    </span>
                  </span>
                  {m.mine && (
                    <span className="flex-none rounded-full bg-[var(--gold-soft)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--gold-ink)]">Mine</span>
                  )}
                  <span className="flex-none rounded border border-[var(--border)] px-1 text-[9.5px] font-bold text-[var(--text-3)]">{m.currency}</span>
                </button>
              ))}
              {options.length === 0 && <p className="p-4 text-center text-[13px] text-[var(--text-3)]">No matter matches that search.</p>}
            </div>
          )}
          {selected && (
            <p className="mt-1.5 text-[12.5px] text-[var(--text-2)]">
              {selected.feeType} · {selected.title} — approval routes to <b>{selected.partnerName}</b>
            </p>
          )}
          <p className="mt-1 text-xs text-[var(--text-3)]">
            Type a project number like <b>50158-01</b>. Closed matters are hidden. Your matters appear first.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">Date</label>
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-base outline-none focus:border-[var(--navy)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">Activity (workcode)</label>
            <select
              value={workcode}
              onChange={(e) => setWorkcode(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-base outline-none focus:border-[var(--navy)]"
            >
              {WORKCODES.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">Unit</label>
          <input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={units}
            onChange={(e) => setUnits(e.target.value)}
            placeholder="e.g. 1.5"
            className="w-full max-w-[200px] rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-base outline-none focus:border-[var(--navy)]"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {QUICK_UNITS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setUnits(String(v))}
                className="rounded-full border border-[var(--border-strong)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--text-2)] hover:border-[var(--navy)] hover:text-[var(--navy)]"
              >
                {v}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-[var(--text-3)]">1 Unit = 1 hour · recorded to 2 decimals (e.g. 10 min = 0.17), matching the invoice format.</p>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What did you work on? This appears on the client invoice."
            className="min-h-[80px] w-full resize-y rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-base outline-none focus:border-[var(--navy)]"
          />
        </div>

        {error && (
          <p className="rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">{error}</p>
        )}

        <div className="flex gap-2.5 border-t border-[var(--border)] pt-4">
          <button
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-[var(--gold)] px-4 py-2.5 font-semibold text-[#20200a] hover:brightness-105 disabled:opacity-60"
          >
            {busy ? "Saving…" : edit ? "Update draft" : "Save draft"}
          </button>
          <button
            onClick={() => router.push(edit ? "/timesheet" : "/")}
            className="rounded-lg border border-[var(--border-strong)] px-4 py-2.5 font-semibold hover:bg-[var(--surface-2)]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
