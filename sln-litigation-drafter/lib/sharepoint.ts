import Anthropic from "@anthropic-ai/sdk";
import type { FileEntry } from "@/types";

// ---------------------------------------------------------------------------
// Token — plain fetch to avoid Azure SDK bundling issues
// ---------------------------------------------------------------------------
let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getM365Token(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && _cachedToken.expiresAt > now + 60_000) {
    return _cachedToken.token;
  }
  const tenantId = process.env.AZURE_TENANT_ID!;
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.AZURE_CLIENT_ID!,
    client_secret: process.env.AZURE_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    { method: "POST", body: params }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure token error ${res.status}: ${text}`);
  }
  const json = await res.json();
  _cachedToken = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return _cachedToken.token;
}

// ---------------------------------------------------------------------------
// MCP query via M365 connector
// ---------------------------------------------------------------------------
async function mcpQuery(instruction: string, systemPrompt?: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const authToken = await getM365Token();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    messages: [{ role: "user", content: instruction }],
    mcp_servers: [
      {
        type: "url",
        name: "microsoft365",
        url: "https://microsoft365.mcp.claude.com/mcp",
        authorization_token: authToken,
      },
    ],
    betas: ["mcp-client-2025-04-04"],
  };
  if (systemPrompt) params.system = systemPrompt;

  const response = await client.beta.messages.create(params);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response.content as any[])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text as string)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function listMatterFiles(folderPath: string): Promise<FileEntry[]> {
  const instruction = `List ALL files recursively inside this SharePoint folder: "${folderPath}"
Include files in all subfolders. Return ONLY a JSON array, no other text:
[
  { "name": "filename.docx", "path": "full/path/to/file.docx", "size": "45 KB", "type": "docx" },
  ...
]
Include only docx, pdf, doc, txt files. Skip folders, images, and system files.`;

  const raw = await mcpQuery(
    instruction,
    "You are a SharePoint file listing assistant. Return only valid JSON arrays, no markdown, no explanation."
  );

  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files = JSON.parse(match[0]) as any[];
    return files.map((f, i) => ({
      id: `file-${i}`,
      name: f.name,
      path: f.path,
      size: f.size || "",
      type: f.type || f.name.split(".").pop() || "",
      selected: true,
    }));
  } catch {
    return [];
  }
}

export async function readFileContent(filePath: string): Promise<string> {
  const instruction = `Read the full text content of this SharePoint file: "${filePath}"
Return the complete text content of the document. Do not summarize. Do not truncate.
Extract all readable text from the document.`;

  return mcpQuery(
    instruction,
    "You are a document reader. Return the complete raw text content of the document."
  );
}

export async function readMultipleFiles(
  files: FileEntry[]
): Promise<{ name: string; content: string }[]> {
  const results = [];
  for (const file of files) {
    const content = await readFileContent(file.path);
    results.push({ name: file.name, content });
  }
  return results;
}
