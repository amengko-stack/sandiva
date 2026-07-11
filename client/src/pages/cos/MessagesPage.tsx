import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Sidebar from "@/components/Sidebar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  UrgencyBadge, CategoryBadge, timeAgo, fmtDateTime, parseActionItems,
  type CosMessage,
} from "./shared";

export default function MessagesPage({ source, title, subtitle }: {
  source: "email" | "teams";
  title: string;
  subtitle: string;
}) {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  const listUrl = `/api/cos/messages?source=${source}`;
  const { data: messages = [], isLoading } = useQuery<CosMessage[]>({
    queryKey: [listUrl],
  });

  const selected = messages.find(m => m.id === selectedId) || null;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [listUrl] });
    queryClient.invalidateQueries({ queryKey: ["/api/cos/brief"] });
  };

  const syncMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/cos/sync", {}),
    onSuccess: async res => {
      const data = await res.json();
      invalidate();
      toast({ title: "Synced", description: `${data.inserted} new message(s) triaged.` });
    },
    onError: (e: any) => toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });

  const readMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/cos/messages/${id}/read`, {}),
    onSuccess: invalidate,
  });

  const archiveMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/cos/messages/${id}/archive`, {}),
    onSuccess: () => {
      invalidate();
      setSelectedId(null);
      toast({ title: "Archived" });
    },
  });

  const draftMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/cos/messages/${id}/draft-reply`, {}),
    onSuccess: async res => {
      const data = await res.json();
      setDraft(data.reply);
    },
    onError: (e: any) => toast({ title: "Draft failed", description: e.message, variant: "destructive" }),
  });

  const reminderMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/cos/messages/${id}/to-reminder`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cos/reminders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cos/brief"] });
      toast({ title: "Reminder created", description: "Find it under Reminders." });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  function openMessage(m: CosMessage) {
    setSelectedId(m.id);
    setDraft(null);
    if (!m.is_read) readMutation.mutate(m.id);
  }

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main className="main-content">
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <Button
            data-testid="button-sync"
            size="sm"
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            {syncMutation.isPending ? "Syncing…" : "↻ Sync"}
          </Button>
        </div>

        <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
          {/* Message list */}
          <div className="lg:col-span-2 space-y-2">
            {isLoading && <div className="skeleton h-24 rounded-lg" />}
            {!isLoading && messages.length === 0 && (
              <Card className="border-dashed">
                <CardContent className="pt-4 text-sm text-muted-foreground">
                  No messages. Hit Sync to pull from your {source === "email" ? "inbox" : "Teams"}.
                </CardContent>
              </Card>
            )}
            {messages.map(m => (
              <Card
                key={m.id}
                data-testid={`message-card-${m.id}`}
                onClick={() => openMessage(m)}
                className={`cursor-pointer transition-colors ${selectedId === m.id ? "border-primary" : "hover:border-primary/40"} ${!m.is_read ? "bg-primary/5" : ""}`}
              >
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm truncate ${!m.is_read ? "font-semibold" : "font-medium"}`}>{m.sender}</span>
                    {m.channel && m.channel !== "DM" && (
                      <span className="text-xs text-muted-foreground truncate"># {m.channel}</span>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">{timeAgo(m.received_at)}</span>
                  </div>
                  <div className="text-sm truncate mt-0.5">{m.subject || m.body.slice(0, 80)}</div>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    <UrgencyBadge urgency={m.urgency} />
                    <CategoryBadge category={m.category} />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Detail panel */}
          <div className="lg:col-span-3">
            {!selected ? (
              <Card className="border-dashed">
                <CardContent className="pt-4 text-sm text-muted-foreground">
                  Select a message to see the triage summary, action items, and reply draft.
                </CardContent>
              </Card>
            ) : (
              <Card data-testid="message-detail">
                <CardContent className="pt-4 space-y-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-semibold">{selected.subject || `Message from ${selected.sender}`}</h2>
                      <UrgencyBadge urgency={selected.urgency} />
                      <CategoryBadge category={selected.category} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {selected.sender}{selected.sender_email ? ` <${selected.sender_email}>` : ""}
                      {selected.channel ? ` · ${selected.channel}` : ""} · {fmtDateTime(selected.received_at)}
                    </p>
                  </div>

                  {selected.triage_summary && (
                    <div className="bg-muted/60 rounded-md p-3">
                      <div className="text-xs font-semibold text-muted-foreground mb-1">TRIAGE SUMMARY</div>
                      <p className="text-sm">{selected.triage_summary}</p>
                      {selected.suggested_deadline && (
                        <p className="text-xs text-muted-foreground mt-1.5">⏱ Suggested deadline: {fmtDateTime(selected.suggested_deadline)}</p>
                      )}
                    </div>
                  )}

                  {parseActionItems(selected.action_items).length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-1">ACTION ITEMS</div>
                      <ul className="space-y-1">
                        {parseActionItems(selected.action_items).map((item, i) => (
                          <li key={i} className="text-sm flex gap-2"><span>☐</span><span>{item}</span></li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mb-1">MESSAGE</div>
                    <p className="text-sm whitespace-pre-wrap">{selected.body}</p>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap border-t pt-3">
                    <Button
                      data-testid="button-draft-reply"
                      size="sm"
                      onClick={() => draftMutation.mutate(selected.id)}
                      disabled={draftMutation.isPending}
                    >
                      {draftMutation.isPending ? "Drafting…" : "✍️ Draft reply"}
                    </Button>
                    <Button
                      data-testid="button-to-reminder"
                      size="sm"
                      variant="outline"
                      onClick={() => reminderMutation.mutate(selected.id)}
                      disabled={reminderMutation.isPending}
                    >
                      ⏰ Add reminder
                    </Button>
                    <Button
                      data-testid="button-archive"
                      size="sm"
                      variant="ghost"
                      onClick={() => archiveMutation.mutate(selected.id)}
                      disabled={archiveMutation.isPending}
                    >
                      🗂 Archive
                    </Button>
                  </div>

                  {draft !== null && (
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-1">DRAFT REPLY (edit before sending)</div>
                      <Textarea
                        data-testid="draft-reply-text"
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        rows={9}
                        className="text-sm"
                      />
                      <div className="flex gap-2 mt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="button-copy-draft"
                          onClick={() => {
                            navigator.clipboard?.writeText(draft);
                            toast({ title: "Copied to clipboard" });
                          }}
                        >
                          📋 Copy
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
