import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface Group {
  id: number;
  name: string;
  color: string;
}

const navItems = [
  { href: "/", label: "Overview", icon: GridIcon },
  { href: "/upload", label: "Upload Chat", icon: UploadIcon },
  { href: "/reports", label: "Report Config", icon: BellIcon },
];

const cosNavItems = [
  { href: "/cos", label: "Daily Brief", icon: SunIcon },
  { href: "/cos/inbox", label: "Inbox", icon: MailIcon },
  { href: "/cos/teams", label: "MS Teams", icon: ChatIcon },
  { href: "/cos/intake", label: "Client Intake", icon: ScaleIcon },
  { href: "/cos/reminders", label: "Reminders", icon: ClockIcon },
];

export default function Sidebar() {
  const [location] = useLocation();
  const { data: groups = [] } = useQuery<Group[]>({
    queryKey: ["/api/groups"],
  });

  return (
    <aside className="sidebar">
      {/* Logo */}
      <div className="px-4 py-5 border-b" style={{ borderColor: "hsl(var(--sidebar-border))" }}>
        <div className="flex items-center gap-2.5">
          <svg aria-label="SANDIVA Chat Intel" viewBox="0 0 32 32" width="28" height="28" fill="none">
            <rect width="32" height="32" rx="8" fill="hsl(163 45% 30%)" />
            <path d="M8 22 C8 14 24 10 24 10 C24 10 20 18 16 20 C12 22 8 22 8 22Z" fill="white" opacity="0.9"/>
            <circle cx="22" cy="10" r="3" fill="hsl(163 65% 70%)" />
          </svg>
          <div>
            <div className="text-sm font-semibold leading-tight" style={{ color: "hsl(var(--sidebar-text))" }}>Chat Intel</div>
            <div className="text-xs" style={{ color: "hsl(var(--sidebar-muted))" }}>SANDIVA</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="px-2 pt-4 pb-2 flex-1">
        <div className="text-xs font-medium mb-1 px-2" style={{ color: "hsl(var(--sidebar-muted))" }}>MENU</div>
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = location === href;
          return (
            <Link key={href} href={href}>
              <a
                data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm mb-0.5 transition-colors"
                style={{
                  color: active ? "hsl(var(--sidebar-text))" : "hsl(var(--sidebar-muted))",
                  background: active ? "hsl(var(--sidebar-accent))" : "transparent",
                }}
              >
                <Icon size={15} />
                {label}
              </a>
            </Link>
          );
        })}

        {/* Chief of Staff */}
        <div className="text-xs font-medium mt-4 mb-1 px-2" style={{ color: "hsl(var(--sidebar-muted))" }}>CHIEF OF STAFF</div>
        {cosNavItems.map(({ href, label, icon: Icon }) => {
          const active = location === href;
          return (
            <Link key={href} href={href}>
              <a
                data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm mb-0.5 transition-colors"
                style={{
                  color: active ? "hsl(var(--sidebar-text))" : "hsl(var(--sidebar-muted))",
                  background: active ? "hsl(var(--sidebar-accent))" : "transparent",
                }}
              >
                <Icon size={15} />
                {label}
              </a>
            </Link>
          );
        })}

        {/* Groups */}
        <div className="text-xs font-medium mt-4 mb-1 px-2" style={{ color: "hsl(var(--sidebar-muted))" }}>GROUPS</div>
        {groups.map(g => {
          const active = location === `/group/${g.id}`;
          return (
            <Link key={g.id} href={`/group/${g.id}`}>
              <a
                data-testid={`nav-group-${g.id}`}
                className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm mb-0.5 transition-colors"
                style={{
                  color: active ? "hsl(var(--sidebar-text))" : "hsl(var(--sidebar-muted))",
                  background: active ? "hsl(var(--sidebar-accent))" : "transparent",
                }}
              >
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: g.color }} />
                <span className="truncate">{g.name}</span>
              </a>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t text-xs" style={{ borderColor: "hsl(var(--sidebar-border))", color: "hsl(var(--sidebar-muted))" }}>
        {new Date().toLocaleDateString("id-ID", { year: "numeric", month: "short", day: "numeric" })}
      </div>
    </aside>
  );
}

function GridIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>;
}
function UploadIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>;
}
function BellIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>;
}
function SunIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="7" y2="7"/><line x1="17" y1="17" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="7" y2="17"/><line x1="17" y1="7" x2="19.1" y2="4.9"/></svg>;
}
function MailIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/></svg>;
}
function ChatIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>;
}
function ScaleIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="3" x2="12" y2="21"/><path d="M8 21h8"/><path d="M4 7h16"/><path d="M6 7l-2 5a3 3 0 006 0L8 7"/><path d="M18 7l-2 5a3 3 0 006 0l-2-5"/></svg>;
}
function ClockIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>;
}
