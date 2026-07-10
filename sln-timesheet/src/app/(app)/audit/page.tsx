import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, tables } from "@/db";
import { getCurrentUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

const ACTION_LABEL: Record<string, string> = {
  entry_write_down: "Write-down",
  invoice_issued: "Invoice issued",
  invoice_voided: "Invoice voided",
  matter_closed: "Matter closed",
  matter_active: "Matter reopened",
  matter_reassign_partner: "Engagement partner changed",
  rate_added: "Rate added",
  user_deactivated: "User deactivated",
  user_reactivated: "User reactivated",
};

export default async function AuditPage({ searchParams }: { searchParams: { action?: string } }) {
  const user = (await getCurrentUser())!;
  if (user.role !== "admin") redirect("/");

  const filter = searchParams.action;
  const rows = await db()
    .select({
      id: tables.auditLog.id,
      action: tables.auditLog.action,
      entity: tables.auditLog.entity,
      entityId: tables.auditLog.entityId,
      before: tables.auditLog.before,
      after: tables.auditLog.after,
      createdAt: tables.auditLog.createdAt,
      actorName: tables.users.name,
      actorInitials: tables.users.initials,
    })
    .from(tables.auditLog)
    .innerJoin(tables.users, eq(tables.auditLog.actorId, tables.users.id))
    .orderBy(desc(tables.auditLog.id))
    .limit(200);

  const filtered = filter ? rows.filter((r: any) => r.action === filter) : rows;
  const actions = [...new Set(rows.map((r: any) => r.action))] as string[];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <a href="/audit" className={`rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${!filter ? "border-[var(--navy)] bg-[var(--navy)] text-white" : "border-[var(--border-strong)] text-[var(--text-2)]"}`}>
          All
        </a>
        {actions.map((a) => (
          <a key={a} href={`/audit?action=${a}`} className={`rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${filter === a ? "border-[var(--navy)] bg-[var(--navy)] text-white" : "border-[var(--border-strong)] text-[var(--text-2)]"}`}>
            {ACTION_LABEL[a] ?? a}
          </a>
        ))}
      </div>

      <section className="rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-sm">
        <header className="flex items-center border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Audit log</h2>
          <span className="flex-1" />
          <span className="text-xs text-[var(--text-3)]">latest {filtered.length} of {rows.length}</span>
        </header>
        {filtered.map((r: any) => (
          <div key={r.id} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-t border-[var(--border)] px-4 py-2 text-[12.5px]">
            <span className="num flex-none text-[11px] text-[var(--text-3)]">
              {new Date(r.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short" })}
            </span>
            <span className="flex-none font-semibold">{ACTION_LABEL[r.action] ?? r.action}</span>
            <span className="flex-none text-[var(--text-3)]">{r.entity} #{r.entityId}</span>
            <span className="flex-none text-[var(--text-2)]">by {r.actorInitials} · {r.actorName}</span>
            {(r.before || r.after) && (
              <span className="num min-w-0 truncate text-[11px] text-[var(--text-3)]">
                {r.before ? `before ${JSON.stringify(r.before)}` : ""} {r.after ? `→ ${JSON.stringify(r.after)}` : ""}
              </span>
            )}
          </div>
        ))}
        {filtered.length === 0 && <p className="p-4 text-sm text-[var(--text-3)]">Nothing recorded yet.</p>}
      </section>
    </div>
  );
}
