import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import Sidebar from "@/components/Sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { UrgencyBadge, parseAnalysis, type CosIntake, type CosMatter } from "./shared";

const STATUS_STYLES: Record<string, string> = {
  new: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  analyzed: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  converted: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  declined: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

export default function Intake() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [clientName, setClientName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [description, setDescription] = useState("");

  const { data: intakes = [], isLoading } = useQuery<CosIntake[]>({
    queryKey: ["/api/cos/intakes"],
  });
  const { data: matters = [] } = useQuery<CosMatter[]>({
    queryKey: ["/api/cos/matters"],
  });

  const selected = intakes.find(i => i.id === selectedId) || null;
  const analysis = selected ? parseAnalysis(selected.analysis) : null;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/cos/intakes"] });
    queryClient.invalidateQueries({ queryKey: ["/api/cos/matters"] });
    queryClient.invalidateQueries({ queryKey: ["/api/cos/brief"] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/cos/intakes", {
        client_name: clientName,
        contact_email: contactEmail || null,
        matter_description: description,
        source: "manual",
      }),
    onSuccess: async res => {
      const intake = await res.json();
      invalidate();
      setClientName(""); setContactEmail(""); setDescription("");
      setSelectedId(intake.id);
      toast({ title: "Intake created", description: "Run the legal analysis when ready." });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const analyzeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/cos/intakes/${id}/analyze`, {}),
    onSuccess: () => {
      invalidate();
      toast({ title: "Analysis complete" });
    },
    onError: (e: any) => toast({ title: "Analysis failed", description: e.message, variant: "destructive" }),
  });

  const convertMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/cos/intakes/${id}/convert`, {}),
    onSuccess: () => {
      invalidate();
      toast({ title: "Matter opened", description: "The intake was converted to an active matter." });
    },
    onError: (e: any) => toast({ title: "Convert failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main className="main-content">
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4">
          <h1 className="text-lg font-semibold">Client Intake</h1>
          <p className="text-sm text-muted-foreground">New matters, initial legal analysis, and conflict checks</p>
        </div>

        <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
          <div className="lg:col-span-2 space-y-4">
            {/* New intake form */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">New Intake</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Prospective client *</label>
                  <Input data-testid="input-client-name" value={clientName} onChange={e => setClientName(e.target.value)} placeholder="Acme Corp" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Contact email</label>
                  <Input data-testid="input-contact-email" type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="contact@acme.com" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Matter description *</label>
                  <Textarea
                    data-testid="input-description"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    rows={5}
                    placeholder="Describe the dispute, parties involved, timeline, and what the client wants…"
                  />
                </div>
                <Button
                  data-testid="button-create-intake"
                  className="w-full"
                  onClick={() => createMutation.mutate()}
                  disabled={!clientName || !description || createMutation.isPending}
                >
                  {createMutation.isPending ? "Saving…" : "Create intake"}
                </Button>
              </CardContent>
            </Card>

            {/* Intake list */}
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">INTAKES</h2>
              <div className="space-y-2">
                {isLoading && <div className="skeleton h-16 rounded-lg" />}
                {intakes.map(i => (
                  <Card
                    key={i.id}
                    data-testid={`intake-card-${i.id}`}
                    onClick={() => setSelectedId(i.id)}
                    className={`cursor-pointer transition-colors ${selectedId === i.id ? "border-primary" : "hover:border-primary/40"}`}
                  >
                    <CardContent className="pt-3 pb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{i.client_name}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ml-auto ${STATUS_STYLES[i.status] || STATUS_STYLES.new}`}>
                          {i.status}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{i.matter_description}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            {/* Matters */}
            {matters.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-muted-foreground mb-2">ACTIVE MATTERS</h2>
                <Card>
                  <CardContent className="pt-3 pb-3 divide-y">
                    {matters.map(m => (
                      <div key={m.id} className="py-1.5 first:pt-0 last:pb-0" data-testid={`matter-${m.id}`}>
                        <div className="text-sm font-medium">{m.matter_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {m.client_name} · {m.practice_area.replace(/_/g, " ")}
                          {m.adverse_party ? ` · adverse: ${m.adverse_party}` : ""}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>

          {/* Detail / analysis panel */}
          <div className="lg:col-span-3">
            {!selected ? (
              <Card className="border-dashed">
                <CardContent className="pt-4 text-sm text-muted-foreground">
                  Select an intake to review it and run the legal analysis.
                </CardContent>
              </Card>
            ) : (
              <Card data-testid="intake-detail">
                <CardContent className="pt-4 space-y-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-semibold">{selected.client_name}</h2>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${STATUS_STYLES[selected.status] || STATUS_STYLES.new}`}>
                        {selected.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {selected.contact_email || "no contact email"} · via {selected.source} · {new Date(selected.created_at).toLocaleDateString()}
                    </p>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-muted-foreground mb-1">MATTER DESCRIPTION</div>
                    <p className="text-sm whitespace-pre-wrap">{selected.matter_description}</p>
                  </div>

                  <div className="flex items-center gap-2 border-t pt-3">
                    <Button
                      data-testid="button-analyze"
                      size="sm"
                      onClick={() => analyzeMutation.mutate(selected.id)}
                      disabled={analyzeMutation.isPending}
                    >
                      {analyzeMutation.isPending ? "Analyzing…" : analysis ? "🔍 Re-run analysis" : "🔍 Run legal analysis"}
                    </Button>
                    {selected.status === "analyzed" && !selected.matter_id && (
                      <Button
                        data-testid="button-convert"
                        size="sm"
                        variant="outline"
                        onClick={() => convertMutation.mutate(selected.id)}
                        disabled={convertMutation.isPending}
                      >
                        📁 Open as matter
                      </Button>
                    )}
                  </div>

                  {analysis && (
                    <div className="space-y-4" data-testid="analysis-report">
                      <div className="bg-muted/60 rounded-md p-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-muted-foreground">INITIAL MATTER VIEW</span>
                          <UrgencyBadge urgency={analysis.urgency} />
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                            {analysis.practice_area.replace(/_/g, " ")}
                          </span>
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                            complexity: {analysis.estimated_complexity}
                          </span>
                        </div>
                        <p className="text-sm">{analysis.summary}</p>
                      </div>

                      {analysis.conflict_flags.length > 0 && (
                        <div className="border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 rounded-md p-3">
                          <div className="text-xs font-semibold text-red-700 dark:text-red-300 mb-1">⚠️ CONFLICT CHECK FLAGS</div>
                          <ul className="space-y-1">
                            {analysis.conflict_flags.map((f, i) => (
                              <li key={i} className="text-sm text-red-800 dark:text-red-200">{f}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {analysis.key_issues.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-muted-foreground mb-1">KEY ISSUES</div>
                          <ul className="space-y-1 list-disc pl-4">
                            {analysis.key_issues.map((issue, i) => (
                              <li key={i} className="text-sm">{issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div>
                        <div className="text-xs font-semibold text-muted-foreground mb-1">RECOMMENDED NEXT STEPS</div>
                        <ol className="space-y-1 list-decimal pl-4">
                          {analysis.recommended_actions.map((a, i) => (
                            <li key={i} className="text-sm">{a}</li>
                          ))}
                        </ol>
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
