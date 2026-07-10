import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <main className="mx-auto max-w-4xl p-8 pt-12">
      <header className="mb-8 flex items-center gap-4">
        <span className="wordmark text-lg">Sandiva</span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-3)]">
          Timesheets
        </span>
        <span className="flex-1" />
        <span className="text-sm text-[var(--text-2)]">
          {user.name} · <b className="capitalize">{user.role}</b>
        </span>
        <LogoutButton />
      </header>

      <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
        <h1 className="text-lg font-semibold">M1 core is running 🎉</h1>
        <p className="mt-2 text-sm text-[var(--text-2)]">
          Auth, roles, schema, rate resolver and the entry state machine are in place. Time
          capture (M2), approvals &amp; invoicing (M3), reports + Ask-AI (M4) land next — the UI
          will match the approved mockup.
        </p>
      </div>
    </main>
  );
}
