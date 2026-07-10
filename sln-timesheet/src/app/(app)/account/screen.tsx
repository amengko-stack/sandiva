"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const inputCls =
  "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-base outline-none focus:border-[var(--navy)] focus:ring-2 focus:ring-[var(--navy)]/20";
const labelCls = "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]";

export function AccountScreen({
  name,
  email,
  role,
  forced,
}: {
  name: string;
  email: string;
  role: string;
  forced: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError("New password and confirmation don't match.");
    setBusy(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Could not change the password.");
    setOk(true);
    setCurrent(""); setNext(""); setConfirm("");
    if (forced) {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <div className="mx-auto flex max-w-[480px] flex-col gap-4">
      {forced && (
        <p className="rounded-card border border-[var(--gold)] bg-[var(--gold-soft)] px-4 py-3 text-[13px] font-medium text-[var(--gold-ink)]">
          <b>Welcome to Sandiva Timesheets.</b> Set your own password to continue — the temporary one from your
          admin stops working after this.
        </p>
      )}

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
        <h2 className="text-sm font-semibold">My account</h2>
        <p className="mb-4 mt-1 text-[13px] text-[var(--text-2)]">
          {name} · {role} · {email}
        </p>

        <form onSubmit={save} className="flex flex-col gap-3.5">
          <div>
            <label className={labelCls}>Current password</label>
            <input type={show ? "text" : "password"} required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>New password (10+ characters)</label>
            <input type={show ? "text" : "password"} required minLength={10} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Confirm new password</label>
            <input type={show ? "text" : "password"} required minLength={10} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} />
          </div>
          <label className="flex items-center gap-2 text-[12.5px] text-[var(--text-2)]">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show passwords
          </label>

          {error && (
            <p className="rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">{error}</p>
          )}
          {ok && !forced && (
            <p className="rounded-lg border border-good/30 bg-good/10 px-3 py-2 text-[13px] font-medium text-good">Password updated.</p>
          )}

          <button type="submit" disabled={busy} className="rounded-lg bg-[var(--gold)] px-4 py-2.5 font-semibold text-[#20200a] hover:brightness-105 disabled:opacity-60">
            {busy ? "Saving…" : "Change password"}
          </button>
        </form>
      </section>
    </div>
  );
}
