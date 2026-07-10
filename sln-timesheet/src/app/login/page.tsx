"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Sign-in failed. Try again.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  async function requestReset() {
    if (!email) {
      setError("Enter your email first, then tap 'Forgot password?'.");
      return;
    }
    setError(null);
    await fetch("/api/auth/request-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setResetSent(true);
  }

  return (
    <main
      className="grid min-h-screen place-items-center p-6"
      style={{
        background:
          "radial-gradient(120% 120% at 15% 0%, #014b6e 0%, var(--navy) 42%, var(--navy-700) 100%)",
      }}
    >
      <div className="w-full max-w-[400px] overflow-hidden rounded-2xl bg-[var(--surface)] shadow-2xl">
        <div className="px-8 pt-8">
          <div className="mb-6 flex items-baseline gap-1">
            <span className="wordmark text-2xl">Sandiva</span>
          </div>
          <h1 className="text-xl font-semibold">Sign in to Timesheets</h1>
          <p className="mb-6 mt-1 text-[13px] text-[var(--text-2)]">
            Record billable time, submit for approval, and generate matter invoices.
          </p>
        </div>
        <form className="px-8 pb-7" onSubmit={submit}>
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">
            Email
          </label>
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-base outline-none focus:border-[var(--navy)] focus:ring-2 focus:ring-[var(--navy)]/20"
          />
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">
            Password
          </label>
          <div className="relative mb-2">
            <input
              type={showPw ? "text" : "password"}
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 pr-11 text-base outline-none focus:border-[var(--navy)] focus:ring-2 focus:ring-[var(--navy)]/20"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? "Hide password" : "Show password"}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
            >
              {showPw ? "🙈" : "👁"}
            </button>
          </div>
          <div className="mb-5 text-right">
            <button
              type="button"
              onClick={requestReset}
              className="text-xs font-semibold text-[var(--navy-300)] hover:underline"
            >
              Forgot password?
            </button>
          </div>
          {resetSent && (
            <p className="mb-4 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text-2)]">
              If that email has an account, a reset link is on its way.
            </p>
          )}
          {error && (
            <p className="mb-4 rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-[var(--gold)] px-4 py-2.5 font-semibold text-[#20200a] hover:brightness-105 disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="border-t border-[var(--border)] bg-[var(--surface-2)] px-8 py-4 text-center text-sm text-[var(--text-3)]">
          SANDIVA · Timesheets System
        </div>
      </div>
    </main>
  );
}
