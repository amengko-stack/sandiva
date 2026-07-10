"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Batch { id: number; filename: string; kind: string; createdAt: string; summary: any }

interface SectionResult {
  filename: string;
  parsed: number;
  parseErrors: { row: number; reason: string }[];
  new: number;
  updated: number;
  unchanged: number;
  skipped: { reason: string; ref: string }[];
}

const badge = (cls: string, text: string) => (
  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>{text}</span>
);

function Section({ label, r }: { label: string; r: SectionResult }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3.5">
      <h3 className="text-[13px] font-semibold">{label}</h3>
      <p className="mb-2 break-all text-[11px] text-[var(--text-3)]">{r.filename} · {r.parsed} rows parsed</p>
      <div className="flex flex-wrap gap-1.5">
        {badge("bg-good/15 text-good", `${r.new} new`)}
        {badge("bg-[var(--navy)]/10 text-[var(--navy)] dark:bg-[#6ea0b9]/20 dark:text-[#9cc4d6]", `${r.updated} updated`)}
        {badge("bg-[var(--surface-3)] text-[var(--text-3)]", `${r.unchanged} unchanged`)}
        {badge(
          r.skipped.length + r.parseErrors.length > 0 ? "bg-burgundy/15 text-burgundy" : "bg-[var(--surface-3)] text-[var(--text-3)]",
          `${r.skipped.length + r.parseErrors.length} flagged`,
        )}
      </div>
      {(r.skipped.length > 0 || r.parseErrors.length > 0) && (
        <ul className="mt-2 max-h-40 overflow-auto text-[12px] text-burgundy">
          {r.parseErrors.slice(0, 20).map((e, i) => (
            <li key={`p${i}`}>Row {e.row}: {e.reason}</li>
          ))}
          {r.skipped.slice(0, 20).map((s, i) => (
            <li key={`s${i}`}>{s.ref}: {s.reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ImportsScreen({ batches }: { batches: Batch[] }) {
  const router = useRouter();
  const [files, setFiles] = useState<{ clients?: File; matters?: File; time?: File }>({});
  const [preview, setPreview] = useState<Record<string, SectionResult> | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(mode: "preview" | "commit") {
    setError(null);
    setDone(null);
    setBusy(mode);
    const form = new FormData();
    form.set("mode", mode);
    if (files.clients) form.set("clients", files.clients);
    if (files.matters) form.set("matters", files.matters);
    if (files.time) form.set("time", files.time);
    const res = await fetch("/api/imports", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) return setError(data.error ?? "Import failed.");
    const sections: Record<string, SectionResult> = {};
    for (const k of ["clients", "matters", "time"]) if (data[k]) sections[k] = data[k];
    setPreview(sections);
    if (mode === "commit") {
      setDone("Import applied. Re-running the same files is safe (idempotent).");
      router.refresh();
    }
  }

  const fileInput = (key: "clients" | "matters" | "time", label: string, hint: string) => (
    <div className="rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] p-3.5">
      <label className="mb-1 block text-[12px] font-semibold">{label}</label>
      <input
        type="file"
        accept=".xls,.xlsx"
        onChange={(e) => setFiles((f) => ({ ...f, [key]: e.target.files?.[0] }))}
        className="block w-full text-[12px] text-[var(--text-2)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--navy)] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
      />
      <p className="mt-1 text-[11px] text-[var(--text-3)]">{hint}</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-card border border-plum/30 bg-plum/5 px-4 py-2.5 text-[12.5px] font-medium text-plum">
        <b>One-time initial setup.</b> Load clients, matters and historical time from Prohukum. After cutover, all
        time is logged in this app — Prohukum is retired. Import order: Users first (in Users &amp; rates), then
        Clients → Matters → Timesheets. Nothing is written until you confirm.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        {fileInput("clients", "1 · Clients export", "Clients-*.xls (HTML-table export)")}
        {fileInput("matters", "2 · Matters export", "Matter_Active-*.xls — Handling Partner becomes the engagement partner")}
        {fileInput("time", "3 · Timesheet report", "Report Activity Timesheets.xlsx — imported as historical, billed, original rates kept")}
      </div>

      <div className="flex gap-2.5">
        <button
          onClick={() => run("preview")}
          disabled={busy !== null}
          className="rounded-lg border border-[var(--border-strong)] px-4 py-2 text-sm font-semibold hover:bg-[var(--surface-2)] disabled:opacity-60"
        >
          {busy === "preview" ? "Parsing…" : "Preview changes"}
        </button>
        <button
          onClick={() => run("commit")}
          disabled={busy !== null || !preview}
          title={!preview ? "Preview first" : undefined}
          className="rounded-lg bg-[var(--gold)] px-4 py-2 text-sm font-semibold text-[#20200a] hover:brightness-105 disabled:opacity-60"
        >
          {busy === "commit" ? "Applying…" : "Confirm import"}
        </button>
      </div>

      {error && <p className="rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">{error}</p>}
      {done && <p className="rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-[13px] font-medium text-good">{done}</p>}

      {preview && (
        <div className="grid gap-3 sm:grid-cols-3">
          {preview.clients && <Section label="Clients" r={preview.clients} />}
          {preview.matters && <Section label="Matters" r={preview.matters} />}
          {preview.time && <Section label="Timesheets" r={preview.time} />}
        </div>
      )}

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <header className="border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Import history</h2>
        </header>
        {batches.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-4 py-2 text-[12.5px]">
            <span className="font-semibold capitalize">{b.kind}</span>
            <span className="break-all text-[var(--text-3)]">{b.filename}</span>
            <span className="flex-1" />
            <span className="num text-[var(--text-2)]">
              +{b.summary?.new ?? 0} / ~{b.summary?.updated ?? 0} / ={b.summary?.unchanged ?? 0}
            </span>
          </div>
        ))}
        {batches.length === 0 && <p className="p-4 text-sm text-[var(--text-3)]">No imports yet.</p>}
      </section>
    </div>
  );
}
