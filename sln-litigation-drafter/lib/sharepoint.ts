import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import type { FileEntry } from "@/types";

// ---------------------------------------------------------------------------
// Token cache
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

async function graphGet(path: string): Promise<Response> {
  const token = await getGraphToken();
  return fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// Site ID resolution cache
// ---------------------------------------------------------------------------
const _siteIdCache: Record<string, string> = {};

async function resolveSiteId(hostname: string, sitePath: string): Promise<string> {
  const key = `${hostname}:${sitePath}`;
  if (_siteIdCache[key]) return _siteIdCache[key];

  const res = await graphGet(`/sites/${hostname}:/${sitePath}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cannot resolve site ${hostname}/${sitePath}: ${text}`);
  }
  const data = await res.json();
  _siteIdCache[key] = data.id;
  return data.id;
}

// ---------------------------------------------------------------------------
// Input parsing
//
// Accepted formats for folder/file paths:
//   1. Full SharePoint URL:
//        https://sandiva.sharepoint.com/sites/5018BVI/Shared%20Documents/Matters
//   2. SharePoint sharing link:
//        https://sandiva.sharepoint.com/:w:/s/5018BVI/IQDJBMI...
//   3. Site-relative shorthand (site name + folder path):
//        5018BVI/Shared Documents/Matters
//   4. Plain path (no site name) — uses SHAREPOINT_SITE_ID env var:
//        Shared Documents/Matters
// ---------------------------------------------------------------------------
function getSharePointHostname(): string {
  return process.env.SHAREPOINT_HOSTNAME ?? "sandiva.sharepoint.com";
}

function isSharingLink(url: string): boolean {
  // Sharing links contain /:w:/, /:b:/, /:f:/, etc. or /s/ segments
  return /\/:[\w]:\//.test(url) || /\/s\//.test(url);
}

interface ParsedLocation {
  type: "sharing-link" | "site-url" | "site-path" | "plain-path";
  siteId?: string; // pre-resolved for plain-path only
  hostname?: string;
  sitePath?: string; // e.g. "sites/5018BVI"
  folderPath: string; // path relative to drive root
  shareId?: string; // for sharing links
}

async function parseLocation(input: string): Promise<ParsedLocation> {
  const trimmed = input.trim();

  // Sharing link (URL containing sharing token)
  if ((trimmed.startsWith("https://") || trimmed.startsWith("http://")) && isSharingLink(trimmed)) {
    return { type: "sharing-link", folderPath: trimmed, shareId: encodeSharingUrl(trimmed) };
  }

  // Full folder URL: https://tenant.sharepoint.com/sites/SiteName/Shared Documents/...
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    const url = new URL(trimmed);
    const hostname = url.hostname;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // parts: ["sites", "5018BVI", "Shared Documents", "Subfolder", ...]
    const sitesIdx = parts.indexOf("sites");
    if (sitesIdx >= 0 && parts[sitesIdx + 1]) {
      const siteName = parts[sitesIdx + 1];
      const sitePath = `sites/${siteName}`;
      // Everything after site name is the drive-relative folder path, minus "Forms/AllItems.aspx" suffixes
      const folderParts = parts.slice(sitesIdx + 2).filter(p => p !== "Forms" && !p.endsWith(".aspx") && !p.startsWith("?"));
      return { type: "site-url", hostname, sitePath, folderPath: folderParts.join("/") };
    }
    // Root site
    return { type: "site-url", hostname, sitePath: "", folderPath: parts.join("/") };
  }

  // Site-relative shorthand: "5018BVI/Shared Documents/Folder"
  // Detect by checking if first segment looks like a site name (no slashes, no extension, no spaces)
  const firstSlash = trimmed.indexOf("/");
  if (firstSlash > 0) {
    const firstSegment = trimmed.slice(0, firstSlash);
    const rest = trimmed.slice(firstSlash + 1);
    // Site names are short alphanumeric strings without spaces or dots
    if (/^[A-Za-z0-9_-]+$/.test(firstSegment)) {
      return {
        type: "site-path",
        hostname: getSharePointHostname(),
        sitePath: `sites/${firstSegment}`,
        folderPath: rest,
      };
    }
  }

  // Plain path — use env SHAREPOINT_SITE_ID
  return { type: "plain-path", siteId: process.env.SHAREPOINT_SITE_ID!, folderPath: trimmed };
}

async function getSiteId(loc: ParsedLocation): Promise<string> {
  if (loc.siteId) return loc.siteId;
  if (loc.hostname && loc.sitePath) return resolveSiteId(loc.hostname, loc.sitePath);
  return process.env.SHAREPOINT_SITE_ID!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

function ext(name: string): string {
  const base = name.split("?")[0];
  return base.split(".").pop()?.toLowerCase() ?? "";
}

function encodeSharingUrl(url: string): string {
  const base64 = Buffer.from(url).toString("base64");
  return "u!" + base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
  const loc = await parseLocation(folderPath);
  const siteId = await getSiteId(loc);
  const results: FileEntry[] = [];
  let index = 0;

  async function recurse(path: string) {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const endpoint = encodedPath
      ? `/sites/${siteId}/drive/root:/${encodedPath}:/children?$select=id,name,size,file,folder`
      : `/sites/${siteId}/drive/root/children?$select=id,name,size,file,folder`;

    const res = await graphGet(endpoint);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph list error ${res.status} [path: ${path}]: ${text}`);
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

  await recurse(normalizePath(loc.folderPath));
  return results;
}

export async function readFileContent(filePath: string): Promise<string> {
  const loc = await parseLocation(filePath);
  let fileExt: string;
  let contentEndpoint: string;

  if (loc.type === "sharing-link") {
    // Resolve metadata to get real filename/extension
    const metaRes = await graphGet(`/shares/${loc.shareId}/driveItem?$select=name`);
    if (!metaRes.ok) {
      const text = await metaRes.text();
      throw new Error(`Graph share resolve error ${metaRes.status}: ${text}`);
    }
    const meta = await metaRes.json();
    fileExt = ext(meta.name ?? "");
    contentEndpoint = `/shares/${loc.shareId}/driveItem/content`;
  } else {
    const siteId = await getSiteId(loc);
    const normalized = normalizePath(loc.folderPath);
    const encodedPath = normalized.split("/").map(encodeURIComponent).join("/");
    fileExt = ext(normalized);
    contentEndpoint = `/sites/${siteId}/drive/root:/${encodedPath}:/content`;
  }

  const res = await graphGet(contentEndpoint);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph download error ${res.status} [${filePath}]: ${text}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);

  if (fileExt === "txt") return bytes.toString("utf-8");

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
            source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
          },
          { type: "text", text: "Extract and return the complete text content of this document. Do not summarize. Do not truncate. Return only the raw text." },
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
