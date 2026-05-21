import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import Sidebar from "@/components/Sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Summary {
  id: number; sessionId: number; groupId: number; date: string;
  overview: string; keyTopics: string[];
  actionItems: { text: string; assignee: string; priority: "high" | "medium" | "low" }[];
  decisions: string[];
  importantMentions: { person: string; context: string }[];
  sentiment: "positive" | "neutral" | "negative";
}

interface ParticipantAgg {
  name: string; messageCount: number; wordCount: number; actionItemsOwned: number; days: number;
}

interface TopicTrend {
  id: number; groupId: number; weekStart: string;
  topics: { topic: string; count: number; trend: "up" | "down" | "flat" }[];
}

interface Group { id: number; name: string; color: string; description: string }

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const groupId = parseInt(id);

  const { data: groups = [] } = useQuery<Group[]>({ queryKey: ["/api/groups"] });
  const group = groups.find(g => g.id === groupId);

  const { data: summaries = [], isLoading: loadSummaries } = useQuery<Summary[]>({
    queryKey: ["/api/groups", groupId, "summaries"],
    queryFn: () => fetch(`/api/groups/${groupId}/summaries`).then(r => r.json()),
  });

  const { data: participants = [] } = useQuery<ParticipantAgg[]>({
    queryKey: ["/api/groups", groupId, "participants"],
    queryFn: () => fetch(`/api/groups/${groupId}/participants`).then(r => r.json()),
  });

  const { data: trends = [] } = useQuery<TopicTrend[]>({
    queryKey: ["/api/groups", groupId, "trends"],
    queryFn: () => fetch(`/api/groups/${groupId}/trends`).then(r => r.json()),
  });

  const latestSummary = summaries[0];
  const latestTrend = trends[0];

  const totalMessages = participants.reduce((s, p) => s + p.messageCount, 0);
  const maxMessages = Math.max(...participants.map(p => p.messageCount), 1);

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main className="main-content">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/">
              <a className="text-sm text-muted-foreground hover:text-foreground">← Back</a>
            </Link>
            {group && (
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full" style={{ background: group.color }} />
                <h1 className="text-lg font-semibold">{group.name}</h1>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-5">
          <Tabs defaultValue="today">
            <TabsList className="mb-4">
              <TabsTrigger value="today" data-testid="tab-today">Today's Summary</TabsTrigger>
              <TabsTrigger value="history" data-testid="tab-history">History</TabsTrigger>
              <TabsTrigger value="trends" data-testid="tab-trends">Weekly Trends</TabsTrigger>
              <TabsTrigger value="engagement" data-testid="tab-engagement">Engagement</TabsTrigger>
            </TabsList>

            {/* Today's Summary */}
            <TabsContent value="today" className="space-y-4">
              {loadSummaries ? (
                <div className="space-y-3">
                  {[1,2,3].map(i => <div key={i} className="skeleton h-24 rounded-lg" />)}
                </div>
              ) : latestSummary ? (
                <>
                  {/* Overview */}
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm">Overview — {latestSummary.date}</CardTitle>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium sentiment-${latestSummary.sentiment}`}>
                          {latestSummary.sentiment === "positive" ? "↑ Positive" : latestSummary.sentiment === "negative" ? "↓ Needs Attention" : "→ Neutral"}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm leading-relaxed">{latestSummary.overview}</p>
                      {latestSummary.keyTopics.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-3">
                          {latestSummary.keyTopics.map(t => (
                            <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">{t}</span>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Action Items */}
                  {latestSummary.actionItems.length > 0 && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Action Items ({latestSummary.actionItems.length})</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {latestSummary.actionItems.map((a, i) => (
                            <div key={i} data-testid={`action-item-${i}`} className="flex items-start gap-2.5 p-2.5 rounded-md bg-muted/50">
                              <span className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 priority-${a.priority}`}>{a.priority.toUpperCase()}</span>
                              <div>
                                <div className="text-sm">{a.text}</div>
                                <div className="text-xs text-muted-foreground mt-0.5">→ {a.assignee}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Decisions */}
                  {latestSummary.decisions.length > 0 && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Decisions Made</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-2">
                          {latestSummary.decisions.map((d, i) => (
                            <li key={i} className="flex gap-2 text-sm">
                              <span className="text-primary font-bold mt-0.5">◆</span> {d}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}

                  {/* Important Mentions */}
                  {latestSummary.importantMentions.length > 0 && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Important Mentions</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {latestSummary.importantMentions.map((m, i) => (
                            <div key={i} className="flex gap-2.5 text-sm">
                              <span className="font-semibold text-primary flex-shrink-0">{m.person}:</span>
                              <span className="text-muted-foreground">{m.context}</span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <div className="text-center py-16 text-muted-foreground">
                  <p className="text-sm">No summaries yet. Upload a chat to get started.</p>
                  <Link href="/upload"><a className="text-sm text-primary hover:underline mt-2 block">Upload Chat →</a></Link>
                </div>
              )}
            </TabsContent>

            {/* History */}
            <TabsContent value="history" className="space-y-3">
              {summaries.slice(1).map(s => (
                <Card key={s.id}>
                  <CardHeader className="pb-1">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">{s.date}</CardTitle>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full sentiment-${s.sentiment}`}>{s.sentiment}</span>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-xs text-muted-foreground leading-relaxed">{s.overview}</p>
                    <div className="flex flex-wrap gap-1">
                      {s.keyTopics.map(t => (
                        <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">{t}</span>
                      ))}
                    </div>
                    {s.actionItems.length > 0 && (
                      <div className="text-xs text-muted-foreground">{s.actionItems.length} action item{s.actionItems.length > 1 ? "s" : ""} · {s.decisions.length} decision{s.decisions.length !== 1 ? "s" : ""}</div>
                    )}
                  </CardContent>
                </Card>
              ))}
              {summaries.length <= 1 && <p className="text-sm text-muted-foreground text-center py-8">No historical summaries yet.</p>}
            </TabsContent>

            {/* Weekly Trends */}
            <TabsContent value="trends">
              {latestTrend ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Most Discussed Topics — Week of {latestTrend.weekStart}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {latestTrend.topics.map((t, i) => {
                        const maxCount = Math.max(...latestTrend.topics.map(x => x.count), 1);
                        const pct = (t.count / maxCount) * 100;
                        return (
                          <div key={i} data-testid={`trend-topic-${i}`}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-medium">{t.topic}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-muted-foreground tabular">{t.count} mentions</span>
                                <TrendArrow trend={t.trend} />
                              </div>
                            </div>
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{ width: `${pct}%`, background: "hsl(var(--primary))" }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">No trend data yet.</p>
              )}
            </TabsContent>

            {/* Engagement */}
            <TabsContent value="engagement">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Participant Engagement</CardTitle>
                </CardHeader>
                <CardContent>
                  {participants.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b bg-muted/50">
                            <th className="text-left py-2 px-3 text-xs font-medium text-muted-foreground">Participant</th>
                            <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground">Messages</th>
                            <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground">Words</th>
                            <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground">Action Items</th>
                            <th className="text-right py-2 px-3 text-xs font-medium text-muted-foreground">Active Days</th>
                            <th className="py-2 px-3 text-xs font-medium text-muted-foreground">Activity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {participants.map((p, i) => {
                            const pct = Math.round((p.messageCount / maxMessages) * 100);
                            const engLevel = pct >= 60 ? "High" : pct >= 30 ? "Medium" : "Low";
                            const engColor = pct >= 60 ? "text-green-600" : pct >= 30 ? "text-orange-500" : "text-gray-400";
                            return (
                              <tr key={i} data-testid={`participant-row-${i}`} className="border-b last:border-0 hover:bg-muted/30">
                                <td className="py-2.5 px-3 font-medium">{p.name}</td>
                                <td className="py-2.5 px-3 text-right tabular">{p.messageCount.toLocaleString()}</td>
                                <td className="py-2.5 px-3 text-right tabular text-muted-foreground">{p.wordCount.toLocaleString()}</td>
                                <td className="py-2.5 px-3 text-right tabular">{p.actionItemsOwned}</td>
                                <td className="py-2.5 px-3 text-right tabular">{p.days}</td>
                                <td className="py-2.5 px-3">
                                  <div className="flex items-center gap-2">
                                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "hsl(var(--primary))" }} />
                                    </div>
                                    <span className={`text-xs font-medium ${engColor}`}>{engLevel}</span>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-6">No participant data yet.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}

function TrendArrow({ trend }: { trend: "up" | "down" | "flat" }) {
  if (trend === "up") return <span className="trend-up text-sm font-bold">↑</span>;
  if (trend === "down") return <span className="trend-down text-sm font-bold">↓</span>;
  return <span className="trend-flat text-sm">→</span>;
}
