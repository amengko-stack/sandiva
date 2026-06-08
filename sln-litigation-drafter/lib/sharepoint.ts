import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import type { FileEntry } from "@/types";

// ---------------------------------------------------------------------------
// Token — plain fetch, no Azure SDK
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
  _cachedToken = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  return _cachedToken.token;
}

async function graphFetch(path: string): Promise<Response> {
  const token = await getGraphToken();
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// Input parsing
// Accepted formats:
//   1. SharePoint sharing link: https://tenant.sharepoint.com/:w:/s/SiteName/...
//   2. Full folder/file URL:    https://tenant.sharepoint.com/sites/SiteName/Shared%20Documents/...
//   3. Site shorthand:          SiteName/Shared Documents/Folder
//   4. Plain path:              Shared Documents/Folder  (uses SHAREPOINT_SITE_ID env var)
// ---------------------------------------------------------------------------
function encodeSharingUrl(url: string): string {
  const b64 = Buffer.from(url).toString("base64");
  return "u!" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isSharingLink(url: string): boolean {
  return /\/:[\w!]:\//.test(url) || /\/s\/[A-Za-z0-9_-]{10,}/.test(url);
}

function normalizePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

function fileExt(name: string): string {
  return name.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
}

const ALLOWED_EXTENSIONS = new Set(["docx", "pdf", "doc", "txt"]);

interface ParsedInput {
  kind: "sharing-link" | "site-url" | "plain";
  shareId?: string;
  siteAddr?: string; // Graph API site address: "hostname:/sites/SiteName" or env site ID
  folderPath: string;
}

// Build the Graph API site address used directly in endpoints — no GUID lookup needed.
// e.g. "sandiva.sharepoint.com:/sites/5018BVI"
function siteAddr(hostname: string, siteName: string): string {
  return `${hostname}:/sites/${siteName}`;
}

async function parseInput(input: string): Promise<ParsedInput> {
  const trimmed = input.trim();

  // 1. Sharing link
  if (trimmed.startsWith("http") && isSharingLink(trimmed)) {
    return { kind: "sharing-link", shareId: encodeSharingUrl(trimmed), folderPath: trimmed };
  }

  // 2. Full URL: https://sandiva.sharepoint.com/sites/5018BVI/Shared Documents/...
  if (trimmed.startsWith("http")) {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const sitesIdx = parts.indexOf("sites");
    if (sitesIdx >= 0 && parts[sitesIdx + 1]) {
      const siteName = parts[sitesIdx + 1];
      const folderParts = parts
        .slice(sitesIdx + 2)
        .filter((p) => p !== "Forms" && !p.endsWith(".aspx"));
      return {
        kind: "site-url",
        siteAddr: siteAddr(url.hostname, siteName),
        folderPath: folderParts.join("/"),
      };
    }
    // Root site — fall back to env SHAREPOINT_SITE_ID
    return { kind: "plain", siteAddr: process.env.SHAREPOINT_SITE_ID!, folderPath: parts.join("/") };
  }

  // 3. Site shorthand: "5018BVI/Shared Documents/Folder"
  const firstSlash = trimmed.indexOf("/");
  if (firstSlash > 0) {
    const first = trimmed.slice(0, firstSlash);
    if (/^[A-Za-z0-9_-]+$/.test(first)) {
      const hostname = process.env.SHAREPOINT_HOSTNAME ?? "sandiva.sharepoint.com";
      return {
        kind: "site-url",
        siteAddr: siteAddr(hostname, first),
        folderPath: trimmed.slice(firstSlash + 1),
      };
    }
  }

  // 4. Plain path — use env SHAREPOINT_SITE_ID
  return { kind: "plain", siteAddr: process.env.SHAREPOINT_SITE_ID!, folderPath: trimmed };
}

function encodedSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------
interface GraphItem {
  id: string;
  name: string;
  size?: number;
  file?: object;
  folder?: object;
}

async function listChildren(siteId: string, path: string): Promise<GraphItem[]> {
  const encoded = encodedSegments(path);
  const endpoint = encoded
    ? `/sites/${siteId}/drive/root:/${encoded}:/children?$select=id,name,size,file,folder`
    : `/sites/${siteId}/drive/root/children?$select=id,name,size,file,folder`;
  const res = await graphFetch(endpoint);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph list error ${res.status} [${path}]: ${text}`);
  }
  const data = await res.json();
  return data.value ?? [];
}

async function downloadFile(siteId: string, path: string): Promise<ArrayBuffer>;
async function downloadFile(shareId: string): Promise<ArrayBuffer>;
async function downloadFile(siteIdOrShareId: string, path?: string): Promise<ArrayBuffer> {
  const endpoint = path
    ? `/sites/${siteIdOrShareId}/drive/root:/${encodedSegments(path)}:/content`
    : `/shares/${siteIdOrShareId}/driveItem/content`;
  const res = await graphFetch(endpoint);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph download error ${res.status}: ${text}`);
  }
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------
async function extractText(bytes: Buffer, ext: string): Promise<string> {
  if (ext === "txt") return bytes.toString("utf-8");

  if (ext === "docx" || ext === "doc") {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return result.value.trim();
  }

  // PDF — Claude document API
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
            source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
          },
          { type: "text", text: "Extract and return the complete text of this document. Do not summarize or truncate." },
        ],
      },
    ],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text as string).join("\n").trim();
}

// ---------------------------------------------------------------------------
// Drive-based recursive listing (used for sharing link folders)
// ---------------------------------------------------------------------------
async function listChildrenByDriveItem(driveId: string, itemId: string): Promise<GraphItem[]> {
  const res = await graphFetch(
    `/drives/${driveId}/items/${itemId}/children?$select=id,name,size,file,folder`
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph list error ${res.status} [driveItem ${itemId}]: ${text}`);
  }
  const data = await res.json();
  return data.value ?? [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function listMatterFiles(folderPath: string): Promise<FileEntry[]> {
  const parsed = await parseInput(folderPath);
  const results: FileEntry[] = [];
  let index = 0;

  if (parsed.kind === "sharing-link") {
    // Resolve the shared item — it may be a file or a folder
    const metaRes = await graphFetch(
      `/shares/${parsed.shareId}/driveItem?$select=id,name,size,file,folder,parentReference`
    );
    if (!metaRes.ok) {
      const text = await metaRes.text();
      throw new Error(`Share resolve error ${metaRes.status}: ${text}`);
    }
    const root: GraphItem & { parentReference?: { driveId?: string } } = await metaRes.json();
    const driveId: string = root.parentReference?.driveId ?? "";

    if (!root.folder) {
      // It's a single file — return it directly if extension is allowed
      if (root.file && ALLOWED_EXTENSIONS.has(fileExt(root.name))) {
        results.push({
          id: `file-${index++}`,
          name: root.name,
          path: folderPath, // keep original sharing link as path for readFileContent
          size: root.size ? `${Math.round(root.size / 1024)} KB` : "",
          type: fileExt(root.name),
          selected: true,
        });
      }
      return results;
    }

    if (!driveId) {
      throw new Error("Tidak dapat menentukan driveId dari sharing link ini.");
    }

    // Recursive listing via drive items
    const recurseByDrive = async (itemId: string): Promise<void> => {
      const items = await listChildrenByDriveItem(driveId, itemId);
      for (const item of items) {
        if (item.folder) {
          await recurseByDrive(item.id);
        } else if (item.file && ALLOWED_EXTENSIONS.has(fileExt(item.name))) {
          results.push({
            id: `file-${index++}`,
            name: item.name,
            path: `drive:${driveId}:${item.id}`,
            size: item.size ? `${Math.round(item.size / 1024)} KB` : "",
            type: fileExt(item.name),
            selected: true,
          });
        }
      }
    };

    await recurseByDrive(root.id);
    return results;
  }

  // Site-based listing (full URL or plain path)
  const siteId = parsed.siteAddr!;

  const recurse = async (path: string): Promise<void> => {
    const items = await listChildren(siteId, path);
    for (const item of items) {
      if (item.folder) {
        await recurse(path ? `${path}/${item.name}` : item.name);
      } else if (item.file && ALLOWED_EXTENSIONS.has(fileExt(item.name))) {
        const filePath = path ? `${path}/${item.name}` : item.name;
        results.push({
          id: `file-${index++}`,
          name: item.name,
          path: filePath,
          size: item.size ? `${Math.round(item.size / 1024)} KB` : "",
          type: fileExt(item.name),
          selected: true,
        });
      }
    }
  }

  await recurse(normalizePath(parsed.folderPath));
  return results;
}

export async function readFileContent(filePath: string): Promise<string> {
  let ext: string;
  let ab: ArrayBuffer;

  // Resolved drive item path produced by listMatterFiles for folder sharing links
  if (filePath.startsWith("drive:")) {
    const parts = filePath.split(":");
    // format: drive:{driveId}:{itemId}
    const driveId = parts[1];
    const itemId = parts[2];
    ext = fileExt(itemId.includes(".") ? itemId : ""); // itemId has no ext; handled below
    // Fetch name first to get extension
    const metaRes = await graphFetch(`/drives/${driveId}/items/${itemId}?$select=name`);
    if (!metaRes.ok) {
      const text = await metaRes.text();
      throw new Error(`Drive item metadata error ${metaRes.status}: ${text}`);
    }
    const meta = await metaRes.json();
    ext = fileExt(meta.name ?? "");
    const contentRes = await graphFetch(`/drives/${driveId}/items/${itemId}/content`);
    if (!contentRes.ok) {
      const text = await contentRes.text();
      throw new Error(`Drive item download error ${contentRes.status}: ${text}`);
    }
    ab = await contentRes.arrayBuffer();
    return extractText(Buffer.from(ab), ext);
  }

  const parsed = await parseInput(filePath);

  if (parsed.kind === "sharing-link") {
    // Resolve filename from metadata to detect extension
    const metaRes = await graphFetch(`/shares/${parsed.shareId}/driveItem?$select=name`);
    if (!metaRes.ok) {
      const text = await metaRes.text();
      throw new Error(`Share metadata error ${metaRes.status}: ${text}`);
    }
    const meta = await metaRes.json();
    ext = fileExt(meta.name ?? "");
    const contentRes = await graphFetch(`/shares/${parsed.shareId}/driveItem/content`);
    if (!contentRes.ok) {
      const text = await contentRes.text();
      throw new Error(`Share download error ${contentRes.status}: ${text}`);
    }
    ab = await contentRes.arrayBuffer();
  } else {
    const siteId = parsed.siteAddr!;
    const normalized = normalizePath(parsed.folderPath);
    ext = fileExt(normalized);
    const encoded = encodedSegments(normalized);
    const contentRes = await graphFetch(`/sites/${siteId}/drive/root:/${encoded}:/content`);
    if (!contentRes.ok) {
      const text = await contentRes.text();
      throw new Error(`File download error ${contentRes.status} [${filePath}]: ${text}`);
    }
    ab = await contentRes.arrayBuffer();
  }

  return extractText(Buffer.from(ab), ext);
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
