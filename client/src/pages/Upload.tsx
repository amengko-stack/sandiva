import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import Sidebar from "@/components/Sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface Group { id: number; name: string; color: string }

export default function Upload() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const { data: groups = [] } = useQuery<Group[]>({ queryKey: ["/api/groups"] });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile || !selectedGroup) throw new Error("Select a group and file");
      const fd = new FormData();
      fd.append("file", selectedFile);
      fd.append("groupId", selectedGroup);
      fd.append("date", new Date().toISOString().split("T")[0]);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json()).error || "Upload failed");
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: "Upload successful", description: `${data.messageCount} messages detected. LLM analysis in progress…` });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
      setSelectedFile(null);
      setSelectedGroup("");
    },
    onError: (e: any) => {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    },
  });

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) setSelectedFile(file);
  };

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main className="main-content">
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4">
          <h1 className="text-lg font-semibold">Upload Chat Log</h1>
          <p className="text-sm text-muted-foreground">Upload a WhatsApp exported .txt file to generate an AI summary</p>
        </div>

        <div className="px-6 py-5 max-w-2xl space-y-5">
          {/* How to export */}
          <Card className="border-dashed">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">How to Export WhatsApp Chat</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="text-sm space-y-1.5 text-muted-foreground list-decimal list-inside">
                <li>Open the WhatsApp group chat</li>
                <li>Tap the group name → More options (⋮)</li>
                <li>Select <strong className="text-foreground">Export chat</strong> → <strong className="text-foreground">Without media</strong></li>
                <li>Save the .txt file and upload it here</li>
              </ol>
            </CardContent>
          </Card>

          {/* Upload Form */}
          <Card>
            <CardContent className="pt-5 space-y-4">
              {/* Group Selector */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Target Group</label>
                <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                  <SelectTrigger data-testid="select-group">
                    <SelectValue placeholder="Select a group…" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map(g => (
                      <SelectItem key={g.id} value={String(g.id)}>
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ background: g.color }} />
                          {g.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* File Drop Zone */}
              <div
                data-testid="dropzone"
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors"
                style={{ borderColor: dragOver ? "hsl(var(--primary))" : "hsl(var(--border))", background: dragOver ? "hsl(var(--accent))" : "transparent" }}
              >
                <input ref={fileRef} type="file" accept=".txt" className="hidden"
                  onChange={e => { if (e.target.files?.[0]) setSelectedFile(e.target.files[0]); }} />
                {selectedFile ? (
                  <div>
                    <div className="text-2xl mb-2">📄</div>
                    <div className="text-sm font-medium">{selectedFile.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">{(selectedFile.size / 1024).toFixed(1)} KB</div>
                  </div>
                ) : (
                  <div>
                    <div className="text-3xl mb-2">⬆️</div>
                    <div className="text-sm font-medium">Drop .txt file here or click to browse</div>
                    <div className="text-xs text-muted-foreground mt-1">WhatsApp exported chat (.txt, up to 20MB)</div>
                  </div>
                )}
              </div>

              <Button
                data-testid="button-submit-upload"
                onClick={() => uploadMutation.mutate()}
                disabled={!selectedFile || !selectedGroup || uploadMutation.isPending}
                className="w-full"
              >
                {uploadMutation.isPending ? "Processing…" : "Upload & Analyze"}
              </Button>
            </CardContent>
          </Card>

          {/* API Key Notice */}
          <Card className="bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800">
            <CardContent className="pt-4">
              <div className="text-sm text-amber-800 dark:text-amber-200">
                <strong>Anthropic API Key Required:</strong> Set the <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded text-xs">ANTHROPIC_API_KEY</code> environment variable on the server for AI analysis to work. Without it, uploads will still be stored but summaries won't be generated.
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
