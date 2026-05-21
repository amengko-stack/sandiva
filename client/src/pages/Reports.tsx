import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Sidebar from "@/components/Sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface ReportConfig {
  id: number;
  channel: "email" | "slack";
  destination: string;
  frequency: "daily" | "weekly";
  enabled: number;
  lastSent: string | null;
}

export default function Reports() {
  const { toast } = useToast();
  const [channel, setChannel] = useState<"email" | "slack">("email");
  const [destination, setDestination] = useState("");
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");

  const { data: configs = [], isLoading } = useQuery<ReportConfig[]>({
    queryKey: ["/api/report-configs"],
  });

  const createMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/report-configs", { channel, destination, frequency }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/report-configs"] });
      toast({ title: "Report config saved" });
      setDestination("");
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/report-configs/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/report-configs"] }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: number }) =>
      apiRequest("PUT", `/api/report-configs/${id}`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/report-configs"] }),
  });

  const sendNowMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/report-configs/${id}/send-now`, {}),
    onSuccess: () => toast({ title: "Report sent successfully" }),
    onError: (e: any) => toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main className="main-content">
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4">
          <h1 className="text-lg font-semibold">Report Delivery</h1>
          <p className="text-sm text-muted-foreground">Configure email or Slack reports from your WhatsApp groups</p>
        </div>

        <div className="px-6 py-5 max-w-2xl space-y-5">
          {/* Add config */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Add Report Destination</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Channel</label>
                  <Select value={channel} onValueChange={(v: any) => setChannel(v)}>
                    <SelectTrigger data-testid="select-channel">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="email">📧 Email</SelectItem>
                      <SelectItem value="slack">💬 Slack Webhook</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Frequency</label>
                  <Select value={frequency} onValueChange={(v: any) => setFrequency(v)}>
                    <SelectTrigger data-testid="select-frequency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  {channel === "email" ? "Email Address" : "Slack Webhook URL"}
                </label>
                <Input
                  data-testid="input-destination"
                  value={destination}
                  onChange={e => setDestination(e.target.value)}
                  placeholder={channel === "email" ? "you@sandiva.co" : "https://hooks.slack.com/services/…"}
                  type={channel === "email" ? "email" : "url"}
                />
              </div>

              <Button
                data-testid="button-add-config"
                onClick={() => createMutation.mutate()}
                disabled={!destination || createMutation.isPending}
                className="w-full"
              >
                {createMutation.isPending ? "Saving…" : "Add Destination"}
              </Button>
            </CardContent>
          </Card>

          {/* Instructions */}
          <Card className="border-dashed">
            <CardContent className="pt-4">
              <div className="space-y-3 text-sm">
                <div>
                  <div className="font-medium mb-1">📧 Email Setup</div>
                  <p className="text-muted-foreground text-xs">Set <code className="bg-muted px-1 rounded">EMAIL_USER</code> and <code className="bg-muted px-1 rounded">EMAIL_PASS</code> environment variables (Gmail app password) on the server. Reports are sent as HTML with full summaries, action items, and topics.</p>
                </div>
                <div>
                  <div className="font-medium mb-1">💬 Slack Setup</div>
                  <p className="text-muted-foreground text-xs">Create an Incoming Webhook in Slack (Apps → Incoming Webhooks) and paste the URL here. Reports include group summaries and key action items.</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Existing configs */}
          {configs.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">Configured Destinations</h2>
              <div className="space-y-2">
                {configs.map(c => (
                  <Card key={c.id} data-testid={`config-card-${c.id}`}>
                    <CardContent className="pt-3 pb-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm">{c.channel === "email" ? "📧" : "💬"}</span>
                            <span className="text-sm font-medium truncate">{c.destination}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded-full ${c.enabled ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : "bg-gray-100 text-gray-500"}`}>
                              {c.enabled ? "Active" : "Paused"}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {c.frequency} · {c.lastSent ? `Last sent: ${new Date(c.lastSent).toLocaleDateString()}` : "Never sent"}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <Button
                            data-testid={`button-send-now-${c.id}`}
                            size="sm"
                            variant="outline"
                            onClick={() => sendNowMutation.mutate(c.id)}
                            disabled={sendNowMutation.isPending}
                          >
                            Send Now
                          </Button>
                          <Button
                            data-testid={`button-toggle-${c.id}`}
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleMutation.mutate({ id: c.id, enabled: c.enabled ? 0 : 1 })}
                          >
                            {c.enabled ? "Pause" : "Resume"}
                          </Button>
                          <Button
                            data-testid={`button-delete-${c.id}`}
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => deleteMutation.mutate(c.id)}
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
          )}

          {isLoading && <div className="skeleton h-16 rounded-lg" />}
        </div>
      </main>
    </div>
  );
}
