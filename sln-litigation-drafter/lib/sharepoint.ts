import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import type { FileEntry } from "@/types";

// ---------------------------------------------------------------------------
// Token cache (per-invocation; Vercel functions are short-lived)
// ---------------------------------------------------------------------------
let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getGraphToken(): Promise<string> {
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
  _cachedToken = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  };
  return _cachedToken.token;
}

async function graphGet(path: string): Promise<Response> {
  const token = await getGraphToken();
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

function ext(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

const ALLOWED_EXTENSIONS = new Set(["docx", "pdf", "doc", "txt"]);

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  file?: { mimeType: string };
  folder?: object;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function listMatterFiles(folderPath: string): Promise<FileEntry[]> {
  const siteId = process.env.SHAREPOINT_SITE_ID!;
  const normalized = normalizePath(folderPath);
  const results: FileEntry[] = [];
  let index = 0;

  async function recurse(path: string) {
    const endpoint = path
      ? `/sites/${siteId}/drive/root:/${path}:/children?$select=id,name,size,file,folder`
      : `/sites/${siteId}/drive/root/children?$select=id,name,size,file,folder`;

    const res = await graphGet(endpoint);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph list error ${res.status}: ${text}`);
    }
    const data = await res.json();
    const items: GraphItem[] = data.value ?? [];

    for (const item of items) {
      if (item.folder) {
        await recurse(path ? `${path}/${item.name}` : item.name);
      } else if (item.file && ALLOWED_EXTENSIONS.has(ext(item.name))) {
        const filePath = path ? `${path}/${item.name}` : item.name;
        results.push({
          id: `file-${index++}`,
          name: item.name,
          path: filePath,
          size: item.size ? `${Math.round(item.size / 1024)} KB` : "",
          type: ext(item.name),
          selected: true,
        });
      }
    }
  }

  await recurse(normalized);
  return results;
}

export async function readFileContent(filePath: string): Promise<string> {
  const siteId = process.env.SHAREPOINT_SITE_ID!;
  const normalized = normalizePath(filePath);
  const fileExt = ext(normalized);

  const res = await graphGet(
    `/sites/${siteId}/drive/root:/${normalized}:/content`
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph download error ${res.status}: ${text}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);

  if (fileExt === "txt") {
    return bytes.toString("utf-8");
  }

  if (fileExt === "docx" || fileExt === "doc") {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value.trim();
  }

  // PDF — use Claude's document API
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (anthropic.messages.create as any)({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: bytes.toString("base64"),
            },
          },
          {
            type: "text",
            text: "Extract and return the complete text content of this document. Do not summarize. Do not truncate. Return only the raw text.",
          },
        ],
      },
    ],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response.content as any[])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text as string)
    .join("\n")
    .trim();
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
