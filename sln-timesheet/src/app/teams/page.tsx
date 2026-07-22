"use client";

import { useEffect, useState } from "react";

type TeamsState = "signing_in" | "no_account" | "failed";

function TeamsShell({ children }: { children: React.ReactNode }) {
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
          {children}
        </div>
        <div className="mt-7 border-t border-[var(--border)] bg-[var(--surface-2)] px-8 py-4 text-center text-sm text-[var(--text-3)]">
          SANDIVA · Timesheets System
        </div>
      </div>
    </main>
  );
}

function SigningIn() {
  return (
    <div className="pb-7">
      <h1 className="text-xl font-semibold">Signing you in with Microsoft…</h1>
      <p className="mb-1 mt-1 text-[13px] text-[var(--text-2)]">
        Please wait while we connect your Teams account.
      </p>
      <div className="mt-6 flex justify-center">
        <div className="h-8 w-8 animate-pulse rounded-full border-4 border-[var(--gold)] border-t-transparent" />
      </div>
    </div>
  );
}

function NoAccount() {
  return (
    <div className="pb-7">
      <h1 className="text-xl font-semibold">No timesheet account</h1>
      <p className="mb-1 mt-1 text-[13px] text-[var(--text-2)]">
        Your Microsoft account signed in, but there&apos;s no matching timesheet user. Ask your
        admin to add you in Users &amp; rates.
      </p>
    </div>
  );
}

function Failed({ detail }: { detail: string | null }) {
  return (
    <div className="pb-7">
      <h1 className="text-xl font-semibold">Couldn&apos;t sign you in here</h1>
      <p className="mb-4 mt-1 text-[13px] text-[var(--text-2)]">
        Teams sign-in didn&apos;t complete.
      </p>
      {detail && (
        <p className="mb-4 break-all rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[11px] text-[var(--text-3)]">
          Detail for your admin: {detail}
        </p>
      )}
      <a
        href="/"
        target="_blank"
        rel="noopener"
        className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-[var(--gold)] px-4 py-2.5 font-semibold text-[#20200a] hover:brightness-105"
      >
        Open in browser instead
      </a>
    </div>
  );
}

export default function TeamsPage() {
  const [state, setState] = useState<TeamsState>("signing_in");
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function signIn() {
      try {
        const teams = await import("@microsoft/teams-js");
        await teams.app.initialize();
        const token = await teams.authentication.getAuthToken();

        const res = await fetch("/api/auth/teams", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });

        if (cancelled) return;

        if (res.ok) {
          window.location.replace("/");
          return;
        }

        if (res.status === 403) {
          const data = await res.json().catch(() => null);
          if (data?.error === "no_account") {
            setState("no_account");
            return;
          }
        }

        setDetail(`server responded ${res.status}`);
        setState("failed");
      } catch (err) {
        console.error("Teams sign-in failed:", err);
        if (!cancelled) {
          // getAuthToken() failures carry the Entra error text (consent,
          // resource mismatch, ...) — surface it so a non-technical user can
          // relay the exact cause instead of a generic failure.
          setDetail(err instanceof Error ? err.message : String(err));
          setState("failed");
        }
      }
    }

    void signIn();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TeamsShell>
      {state === "signing_in" && <SigningIn />}
      {state === "no_account" && <NoAccount />}
      {state === "failed" && <Failed detail={detail} />}
    </TeamsShell>
  );
}
