"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";

// Role-scoped navigation — matches the approved mockup exactly:
// member: Dashboard / Log time / My timesheet
// partner: + Firm: Approvals / Invoices / Reports
// admin: operations only (NO Approvals — admin never approves timesheets)
type NavItem = { href: string; label: string; badge?: number };
type NavGroup = { label?: string; items: NavItem[] };

export interface ShellUser {
  id: number;
  name: string;
  initials: string;
  role: "member" | "partner" | "admin";
  title: string | null;
}

function navFor(role: ShellUser["role"], pendingApprovals: number): NavGroup[] {
  const mine: NavItem[] = [
    { href: "/", label: "Dashboard" },
    { href: "/log-time", label: "Log time" },
    { href: "/timesheet", label: "My timesheet" },
  ];
  if (role === "member") return [{ items: mine }];
  if (role === "partner")
    return [
      { items: mine },
      {
        label: "Firm",
        items: [
          { href: "/approvals", label: "Approvals", badge: pendingApprovals || undefined },
          { href: "/invoices", label: "Invoices" },
          { href: "/reports", label: "Reports" },
        ],
      },
    ];
  return [
    { items: [{ href: "/", label: "Dashboard" }, { href: "/invoices", label: "Invoices" }, { href: "/reports", label: "Reports" }] },
    {
      label: "Administration",
      items: [
        { href: "/clients", label: "Clients" },
        { href: "/matters", label: "Matters" },
        { href: "/users", label: "Users & rates" },
        { href: "/imports", label: "Initial setup import" },
        { href: "/settings", label: "Settings" },
      ],
    },
  ];
}

function tabsFor(role: ShellUser["role"]): NavItem[] {
  if (role === "member")
    return [
      { href: "/", label: "Home" },
      { href: "/log-time", label: "Log time" },
      { href: "/timesheet", label: "Timesheet" },
    ];
  if (role === "partner")
    return [
      { href: "/", label: "Home" },
      { href: "/log-time", label: "Log time" },
      { href: "/approvals", label: "Approvals" },
    ];
  return [
    { href: "/", label: "Home" },
    { href: "/matters", label: "Matters" },
    { href: "/imports", label: "Import" },
  ];
}

const TITLES: [string, string][] = [
  ["/log-time", "Log time"],
  ["/timesheet", "My timesheet"],
  ["/approvals", "Approvals"],
  ["/invoices", "Invoices"],
  ["/reports", "Reports"],
  ["/clients", "Clients"],
  ["/matters", "Matters"],
  ["/users", "Users & rates"],
  ["/imports", "Initial setup import"],
  ["/settings", "Settings"],
];

export function AppShell({
  user,
  pendingApprovals = 0,
  children,
}: {
  user: ShellUser;
  pendingApprovals?: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const title = TITLES.find(([p]) => pathname.startsWith(p))?.[1] ?? "Dashboard";
  const groups = navFor(user.role, pendingApprovals);
  const tabs = tabsFor(user.role);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  function toggleTheme() {
    const el = document.documentElement;
    el.setAttribute("data-theme", el.getAttribute("data-theme") === "dark" ? "light" : "dark");
  }

  return (
    <div className="grid min-h-screen md:grid-cols-[236px_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen flex-col overflow-auto bg-[var(--navy)] px-3.5 py-5 text-[#cfe0e8] md:flex">
        <div className="px-2 pb-4">
          <span className="wordmark--light text-[17px] font-semibold uppercase tracking-[0.34em]">Sandiva</span>
          <div className="mt-1.5 text-[10px] uppercase tracking-[0.16em] text-[#6f9cb0]">Timesheets</div>
        </div>
        <nav className="flex flex-col gap-0.5">
          {groups.map((g, gi) => (
            <div key={gi} className="flex flex-col gap-0.5">
              {g.label && (
                <div className="px-2.5 pb-1.5 pt-4 text-[10px] uppercase tracking-[0.14em] text-[#6f9cb0]">
                  {g.label}
                </div>
              )}
              {g.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium ${
                    isActive(item.href)
                      ? "bg-white/10 text-white before:absolute before:-left-3.5 before:bottom-2 before:top-2 before:w-[3px] before:rounded-r before:bg-[var(--gold)]"
                      : "text-[#bcd4df] hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {item.label}
                  {item.badge ? (
                    <span className="num ml-auto rounded-full bg-[var(--gold)] px-1.5 text-[10px] font-bold text-[#20200a]">
                      {item.badge}
                    </span>
                  ) : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-2.5 border-t border-white/10 px-2 pt-3">
          <div className="grid h-8 w-8 flex-none place-items-center rounded-full bg-gradient-to-br from-[var(--burgundy)] to-[var(--purple)] text-xs font-bold text-white">
            {user.initials}
          </div>
          <div className="min-w-0 text-[12.5px] leading-tight">
            <div className="truncate font-semibold text-white">{user.name}</div>
            <div className="text-[#8fb2c2]">{user.title ?? user.role}</div>
          </div>
        </div>
        <button
          onClick={signOut}
          className="mt-3 rounded-lg border border-white/20 px-2.5 py-1.5 text-xs text-[#bcd4df] hover:bg-white/5"
        >
          Sign out
        </button>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-30 flex items-center gap-3 bg-[var(--navy)] px-4 py-2.5 text-white md:hidden">
          <span className="wordmark--light text-[15px] font-semibold uppercase tracking-[0.34em]">Sandiva</span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-[#8fb2c2]">Timesheets</span>
          <span className="flex-1" />
          <button onClick={toggleTheme} aria-label="Toggle theme" className="rounded-lg border border-white/25 bg-white/10 px-2 py-1 text-sm">
            ◐
          </button>
          <button onClick={signOut} className="rounded-lg border border-white/25 bg-white/10 px-2 py-1 text-xs">
            Out
          </button>
        </div>

        {/* Desktop top bar */}
        <header className="sticky top-0 z-20 hidden items-center gap-4 border-b border-[var(--border)] bg-[var(--surface)]/90 px-6 py-3 backdrop-blur md:flex">
          <h1 className="text-[17px] font-semibold">{title}</h1>
          <span className="flex-1" />
          <Link
            href="/log-time"
            className="rounded-lg bg-[var(--gold)] px-3 py-1.5 text-[12.5px] font-semibold text-[#20200a] hover:brightness-105"
          >
            + Log time
          </Link>
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            className="grid h-[34px] w-[34px] place-items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--surface-2)]"
          >
            ◐
          </button>
        </header>

        <main className="mx-auto w-full max-w-[1080px] flex-1 px-4 pb-24 pt-5 md:px-6 md:pb-8">{children}</main>
      </div>

      {/* Mobile bottom tabs */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--surface)] pb-[calc(6px+env(safe-area-inset-bottom))] pt-1.5 shadow-[0_-4px_16px_rgba(14,36,48,.08)] md:hidden">
        <div className="flex items-end justify-around">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className={`relative flex flex-1 flex-col items-center gap-0.5 px-1 py-1.5 text-[10.5px] font-semibold ${
                isActive(t.href) ? "text-[var(--navy)] dark:text-[var(--gold)]" : "text-[var(--text-3)]"
              }`}
            >
              <span className="text-lg leading-none">{t.label === "Log time" ? "＋" : t.label === "Home" ? "⌂" : "≡"}</span>
              {t.label}
              {t.href === "/approvals" && pendingApprovals > 0 && (
                <span className="num absolute right-[22%] top-0 rounded-full bg-[var(--gold)] px-1 text-[8.5px] font-extrabold text-[#20200a]">
                  {pendingApprovals}
                </span>
              )}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
