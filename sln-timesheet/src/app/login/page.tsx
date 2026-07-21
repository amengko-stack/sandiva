"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

function errorMessage(error: string | null): string | null {
  if (!error) return null;
  if (error === "no_account") {
    return "No account found for your Microsoft sign-in — contact your administrator to be added.";
  }
  return "Sign-in failed. Try again, or contact your administrator.";
}

function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true" className="flex-none">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

function LoginCard() {
  const search = useSearchParams();
  const error = errorMessage(search.get("error"));

  return (
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
      <div className="px-8 pb-7">
        {error && (
          <p className="mb-4 rounded-lg border border-burgundy/30 bg-burgundy/10 px-3 py-2 text-[13px] font-medium text-burgundy">
            {error}
          </p>
        )}
        <a
          href="/api/auth/entra/login"
          className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-[var(--gold)] px-4 py-2.5 font-semibold text-[#20200a] hover:brightness-105"
        >
          <MicrosoftLogo />
          Sign in with Microsoft
        </a>
        <p className="mt-4 text-center text-[12.5px] text-[var(--text-2)]">
          Use your Sandiva Microsoft 365 account. No separate password needed.
        </p>
      </div>
      <div className="border-t border-[var(--border)] bg-[var(--surface-2)] px-8 py-4 text-center text-sm text-[var(--text-3)]">
        SANDIVA · Timesheets System
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main
      className="grid min-h-screen place-items-center p-6"
      style={{
        background:
          "radial-gradient(120% 120% at 15% 0%, #014b6e 0%, var(--navy) 42%, var(--navy-700) 100%)",
      }}
    >
      <Suspense>
        <LoginCard />
      </Suspense>
    </main>
  );
}
