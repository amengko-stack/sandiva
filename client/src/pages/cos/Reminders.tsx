import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Sidebar from "@/components/Sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { UrgencyBadge, fmtDateTime, type CosReminder, type Urgency } from "./shared";

const BUCKETS: Array<{ key: string; label: string }> = [
  { key: "overdue", label: "⚠️ OVERDUE" },
  { key: "today", label: "📅 TODAY" },
  { key: "upcoming", label: "🔜 UPCOMING" },
  { key: "done", label: "✅ DONE" },
];

export default function Reminders() {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState<Urgency>("medium");

  const { data: reminders = [], isLoading } = useQuery<CosReminder[]>({
    queryKey: ["/api/cos/reminders"],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/cos/reminders"] });
    queryClient.invalidateQueries({ queryKey: ["/api/cos/brief"] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/cos/reminders", {
        title,
        notes: notes || null,
        due_at: new Date(dueAt).toISOString(),
        priority,
      }),
    onSuccess: () => {
      invalidate();
      setTitle(""); setNotes(""); setDueAt("");
      toast({ title: "Reminder created" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) =>
      apiRequest("PATCH", `/api/cos/reminders/${id}`, body),
    onSuccess: invalidate,
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/cos/reminders/${id}`),
    onSuccess: invalidate,
  });

  const grouped = BUCKETS.map(b => ({
    ...b,
    items: reminders.filter(r => r.bucket === b.key),
  }));

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main className="main-content">
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4">
          <h1 className="text-lg font-semibold">Reminders</h1>
          <p className="text-sm text-muted-foreground">Deadlines and follow-ups — overdue items escalate to your Daily Brief</p>
        </div>

        <div className="px-6 py-5 max-w-3xl space-y-5">
          {/* New reminder */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">New Reminder</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Title *</label>
                  <Input data-testid="input-reminder-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="File reply brief" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Due *</label>
                  <Input data-testid="input-reminder-due" type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Priority</label>
                  <Select value={priority} onValueChange={(v: any) => setPriority(v)}>
                    <SelectTrigger data-testid="select-priority"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="critical">Critical</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Notes</label>
                  <Input data-testid="input-reminder-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional context" />
                </div>
              </div>
              <Button
                data-testid="button-create-reminder"
                className="w-full"
                onClick={() => createMutation.mutate()}
                disabled={!title || !dueAt || createMutation.isPending}
              >
                {createMutation.isPending ? "Saving…" : "Add reminder"}
              </Button>
            </CardContent>
          </Card>

          {isLoading && <div className="skeleton h-24 rounded-lg" />}

          {grouped.map(bucket =>
            bucket.items.length === 0 ? null : (
              <div key={bucket.key}>
                <h2 className="text-sm font-semibold text-muted-foreground mb-2">{bucket.label}</h2>
                <div className="space-y-2">
                  {bucket.items.map(r => (
                    <Card key={r.id} data-testid={`reminder-card-${r.id}`} className={bucket.key === "overdue" ? "border-red-300 dark:border-red-800" : ""}>
                      <CardContent className="pt-3 pb-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-sm font-medium ${r.status === "done" ? "line-through text-muted-foreground" : ""}`}>{r.title}</span>
                              <UrgencyBadge urgency={r.priority} />
                            </div>
                            {r.notes && <p className="text-xs text-muted-foreground mt-0.5">{r.notes}</p>}
                            <p className="text-xs text-muted-foreground mt-1">⏱ {fmtDateTime(r.due_at)}</p>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {r.status !== "done" ? (
                              <>
                                <Button
                                  data-testid={`button-complete-${r.id}`}
                                  size="sm" variant="outline"
                                  onClick={() => patchMutation.mutate({ id: r.id, body: { action: "complete" } })}
                                >
                                  ✓ Done
                                </Button>
                                <Button
                                  data-testid={`button-snooze-${r.id}`}
                                  size="sm" variant="ghost"
                                  onClick={() => patchMutation.mutate({ id: r.id, body: { action: "snooze", hours: 24 } })}
                                >
                                  💤 +1d
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="sm" variant="ghost"
                                onClick={() => patchMutation.mutate({ id: r.id, body: { action: "reopen" } })}
                              >
                                ↩ Reopen
                              </Button>
                            )}
                            <Button
                              data-testid={`button-delete-${r.id}`}
                              size="sm" variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => deleteMutation.mutate(r.id)}
                            >
                              ✕
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )
          )}

          {!isLoading && reminders.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="pt-4 text-sm text-muted-foreground">No reminders yet.</CardContent>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
