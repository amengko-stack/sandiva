import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Sidebar from "@/components/Sidebar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { UrgencyBadge, fmtDateTime, type Urgency } from "./shared";

interface BriefItem {
  type: "message" | "reminder" | "intake";
  ref_id: number;
  title: string;
  detail: string;
  urgency: Urgency;
  due_at: string | null;
  source: string;
}

interface DailyBrief {
  generated_at: string;
  date_label: string;
  attention_items: BriefItem[];
  upcoming_deadlines: Array<{ label: string; due_at: string; source: string }>;
  stats: {
    unread_messages: number;
    critical_or_high: number;
    overdue_reminders: number;
    due_today: number;
    pending_intakes: number;
  };
}

const ITEM_LINKS: Record<string, string> = {
  email: "/cos/inbox",
  teams: "/cos/teams",
  reminder: "/cos/reminders",
  intake: "/cos/intake",
};

const SOURCE_ICONS: Record<string, string> = {
  email: "📧",
  teams: "💬",
  reminder: "⏰",
  intake: "📋",
};

export default function DailyBrief() {
  const { toast } = useToast();
  const { data: brief, isLoading } = useQuery<DailyBrief>({
    queryKey: ["/api/cos/brief"],
  });

  const syncMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/cos/sync", {}),
    onSuccess: async res => {
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/cos/brief"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cos/messages"] });
      toast({ title: "Synced", description: `${data.inserted} new message(s) triaged.` });
    },
    onError: (e: any) => toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const stats = brief?.stats;
  const statTiles = stats
    ? [
        { label: "Unread messages", value: stats.unread_messages, testid: "stat-unread" },
        { label: "Critical / high", value: stats.critical_or_high, testid: "stat-critical" },
        { label: "Overdue reminders", value: stats.overdue_reminders, testid: "stat-overdue" },
        { label: "Due today", value: stats.due_today, testid: "stat-due-today" },
        { label: "Pending intakes", value: stats.pending_intakes, testid: "stat-intakes" },
      ]
    : [];

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main className="main-content">
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold" data-testid="brief-greeting">{greeting}, Counselor</h1>
            <p className="text-sm text-muted-foreground">{brief?.date_label || "Your daily brief"}</p>
          </div>
          <Button
            data-testid="button-sync"
            size="sm"
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            {syncMutation.isPending ? "Syncing…" : "↻ Sync inboxes"}
          </Button>
        </div>

        <div className="px-6 py-5 max-w-3xl space-y-5">
          {isLoading && <div className="skeleton h-40 rounded-lg" />}

          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {statTiles.map(t => (
                <Card key={t.label}>
                  <CardContent className="pt-3 pb-3 text-center">
                    <div className="text-xl font-semibold" data-testid={t.testid}>{t.value}</div>
                    <div className="text-xs text-muted-foreground leading-tight">{t.label}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {brief && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">NEEDS YOUR ATTENTION</h2>
              {brief.attention_items.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="pt-4 text-sm text-muted-foreground">
                    All clear — nothing urgent on your desk right now.
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {brief.attention_items.map((item, i) => (
                    <Link key={`${item.type}-${item.ref_id}`} href={ITEM_LINKS[item.source] || "/cos"}>
                      <a className="block" data-testid={`brief-item-${i}`}>
                        <Card className="hover:border-primary/50 transition-colors cursor-pointer">
                          <CardContent className="pt-3 pb-3">
                            <div className="flex items-start gap-3">
                              <span className="text-lg leading-none mt-0.5">{SOURCE_ICONS[item.source] || "•"}</span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium">{item.title}</span>
                                  <UrgencyBadge urgency={item.urgency} />
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.detail}</p>
                                {item.due_at && (
                                  <p className="text-xs text-muted-foreground mt-1">⏱ Due {fmtDateTime(item.due_at)}</p>
                                )}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      </a>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {brief && brief.upcoming_deadlines.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">UPCOMING DEADLINES</h2>
              <Card>
                <CardContent className="pt-3 pb-3 divide-y">
                  {brief.upcoming_deadlines.map((d, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 py-1.5 first:pt-0 last:pb-0" data-testid={`deadline-${i}`}>
                      <span className="text-sm truncate">{SOURCE_ICONS[d.source] || "•"} {d.label}</span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(d.due_at)}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
