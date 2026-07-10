"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Reset failed. Request a new link.");
      return;
    }
    router.push("/login");
  }

  return (
    <div className="w-full max-w-[400px] overflow-hidden rounded-2xl bg-[var(--surface)] shadow-2xl">
      <div className="px-8 pt-8">
        <span className="wordmark text-2xl">Sandiva</span>
        <h1 className="mt-6 text-xl font-semibold">Set a new password</h1>
        <p className="mb-6 mt-1 text-[13px] text-[var(--text-2)]">At least 10 characters.</p>
      </div>
      <form className="px-8 pb-8" onSubmit={submit}>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-2)]">
          New password
        </label>
        <div className="relative mb-5">
          <input
            type={showPw ? "text" : "password"}
            required
            minLength={10}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 pr-11 text-base outline-none focus:border-[var(--navy)] focus:ring-2 focus:ring-[var(--navy)]/20"
          />
          <button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            aria-label={showPw ? "Hide password" : "Show password"}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-[var(--text-3)] hover:bg-[var(--surface-2)]"
          >
            {showPw ? "🙈" : "👁"}
          </button>
        </div>
        {error && (
          <p className="mb-4 rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !token}
          className="w-full rounded-lg bg-[var(--gold)] px-4 py-2.5 font-semibold text-[#20200a] hover:brightness-105 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Set new password"}
        </button>
        {!token && (
          <p className="mt-3 text-center text-[13px] text-[var(--text-3)]">
            This page needs the link from your reset email.
          </p>
        )}
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <main
      className="grid min-h-screen place-items-center p-6"
      style={{
        background:
          "radial-gradient(120% 120% at 15% 0%, #014b6e 0%, var(--navy) 42%, var(--navy-700) 100%)",
      }}
    >
      <Suspense>
        <ResetForm />
      </Suspense>
    </main>
  );
}
