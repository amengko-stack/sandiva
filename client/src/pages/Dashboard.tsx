import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import Sidebar from "@/components/Sidebar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ActionItem { text: string; assignee: string; priority: "high" | "medium" | "low" }
interface ImportantMention { person: string; context: string }
interface GroupSummary {
  group: { id: number; name: string; color: string; description: string };
  latestSummary: {
    id: number; date: string; overview: string;
    keyTopics: string[]; actionItems: ActionItem[];
    decisions: string[]; importantMentions: ImportantMention[];
    sentiment: "positive" | "neutral" | "negative";
  } | null;
  totalMessages: number;
  sessionCount: number;
  participants: { name: string; messageCount: number }[];
}

const sentimentIcon = { positive: "↑", neutral: "→", negative: "↓" };
const sentimentLabel = { positive: "Positive", neutral: "Neutral", negative: "Needs Attention" };

export default function Dashboard() {
  const { data: items = [], isLoading } = useQuery<GroupSummary[]>({
    queryKey: ["/api/dashboard"],
  });

  const totalGroups = items.length;
  const totalActionItems = items.reduce((s, g) => s + (g.latestSummary?.actionItems?.length || 0), 0);
  const totalMessages = items.reduce((s, g) => s + g.totalMessages, 0);
  const groupsNeedingAttention = items.filter(g => g.latestSummary?.sentiment === "negative").length;

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main className="main-content">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold">WhatsApp Intelligence</h1>
              <p className="text-sm text-muted-foreground">
                {new Date().toLocaleDateString("id-ID", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
              </p>
            </div>
            <Link href="/upload">
              <a data-testid="button-upload-header" className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md font-medium" style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Upload Chat
              </a>
            </Link>
          </div>
        </div>

        <div className="px-6 py-5 space-y-6">
          {/* KPI Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: "Active Groups", value: totalGroups, icon: "💬", sub: "Monitored groups" },
              { label: "Open Action Items", value: totalActionItems, icon: "✅", sub: "Across all groups" },
              { label: "Total Messages", value: totalMessages.toLocaleString(), icon: "📨", sub: "All-time" },
              { label: "Need Attention", value: groupsNeedingAttention, icon: "⚠️", sub: "Groups with alerts", alert: groupsNeedingAttention > 0 },
            ].map(kpi => (
              <Card key={kpi.label} data-testid={`kpi-${kpi.label.toLowerCase().replace(/\s/g, "-")}`}>
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-start justify-between mb-1">
                    <span className="text-xs text-muted-foreground font-medium">{kpi.label}</span>
                    <span className="text-base">{kpi.icon}</span>
                  </div>
                  <div className={`text-2xl font-bold tabular ${kpi.alert ? "text-destructive" : ""}`}>{isLoading ? "—" : kpi.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{kpi.sub}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Group Cards */}
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Today's Group Summaries</h2>
            {isLoading ? (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {[1,2,3,4].map(i => (
                  <div key={i} className="rounded-lg border p-5 space-y-3">
                    <div className="skeleton h-5 w-48" />
                    <div className="skeleton h-4 w-full" />
                    <div className="skeleton h-4 w-3/4" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 card-grid">
                {items.map(item => (
                  <GroupCard key={item.group.id} item={item} />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function GroupCard({ item }: { item: GroupSummary }) {
  const { group, latestSummary, totalMessages, participants } = item;
  const s = latestSummary;

  return (
    <Card data-testid={`card-group-${group.id}`} className="hover:shadow-md transition-shadow">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-0.5" style={{ background: group.color }} />
            <CardTitle className="text-sm font-semibold truncate">{group.name}</CardTitle>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {s && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium sentiment-${s.sentiment}`}>
                {sentimentIcon[s.sentiment]} {sentimentLabel[s.sentiment]}
              </span>
            )}
            <Link href={`/group/${group.id}`}>
              <a data-testid={`link-group-${group.id}`} className="text-xs text-primary hover:underline">Details →</a>
            </Link>
          </div>
        </div>
        {s && (
          <p className="text-xs text-muted-foreground leading-relaxed mt-1 line-clamp-3">
            {s.overview}
          </p>
        )}
        {!s && <p className="text-xs text-muted-foreground mt-1">No chat uploaded yet.</p>}
      </CardHeader>

      {s && (
        <CardContent className="space-y-3">
          {/* Topics */}
          {s.keyTopics.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Key Topics</div>
              <div className="flex flex-wrap gap-1">
                {s.keyTopics.slice(0, 4).map(t => (
                  <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">{t}</span>
                ))}
              </div>
            </div>
          )}

          {/* Action Items */}
          {s.actionItems.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Action Items ({s.actionItems.length})</div>
              <ul className="space-y-1">
                {s.actionItems.slice(0, 3).map((a, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 priority-${a.priority}`}>{a.priority}</span>
                    <span><strong>{a.assignee}:</strong> {a.text}</span>
                  </li>
                ))}
                {s.actionItems.length > 3 && (
                  <li className="text-xs text-muted-foreground">+{s.actionItems.length - 3} more…</li>
                )}
              </ul>
            </div>
          )}

          {/* Decisions */}
          {s.decisions.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Decisions Made</div>
              <ul className="space-y-0.5">
                {s.decisions.slice(0, 2).map((d, i) => (
                  <li key={i} className="text-xs text-foreground flex gap-1.5">
                    <span className="text-primary mt-0.5">◆</span> {d}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-1 border-t text-xs text-muted-foreground">
            <span className="tabular">{totalMessages.toLocaleString()} msgs total</span>
            <span>{s.date}</span>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
