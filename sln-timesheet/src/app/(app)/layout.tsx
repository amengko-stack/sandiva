import { and, eq, inArray } from "drizzle-orm";
import { db, tables } from "@/db";
import { requireUser } from "@/lib/auth/current-user";
import { AppShell } from "@/components/shell";
import { AccountScreen } from "./account/screen";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // Admin-created accounts must set their own password before using the app.
  // Render the change-password screen IN PLACE for any URL (no redirect, so no
  // loop is possible). Cleared once mustChangePassword flips to false.
  if (user.mustChangePassword) {
    return (
      <AppShell
        user={{ id: user.id, name: user.name, initials: user.initials, role: user.role, title: user.title }}
      >
        <AccountScreen name={user.name} email={user.email} role={user.title ?? user.role} forced />
      </AppShell>
    );
  }

  // Partner nav badge: submitted entries on THEIR engagement matters.
  let pendingApprovals = 0;
  if (user.role === "partner") {
    const myMatters = await db()
      .select({ id: tables.matters.id })
      .from(tables.matters)
      .where(eq(tables.matters.engagementPartnerId, user.id));
    if (myMatters.length) {
      const rows = await db()
        .select({ id: tables.timeEntries.id })
        .from(tables.timeEntries)
        .where(
          and(
            eq(tables.timeEntries.status, "submitted"),
            inArray(tables.timeEntries.matterId, myMatters.map((m: { id: number }) => m.id)),
          ),
        );
      pendingApprovals = rows.length;
    }
  }

  return (
    <AppShell
      user={{ id: user.id, name: user.name, initials: user.initials, role: user.role, title: user.title }}
      pendingApprovals={pendingApprovals}
    >
      {children}
    </AppShell>
  );
}
