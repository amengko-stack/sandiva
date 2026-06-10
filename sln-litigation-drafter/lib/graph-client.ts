let _cachedToken: { token: string; expiresAt: number } | null = null;

async function graphFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getGraphToken();
  const siteId = process.env.SHAREPOINT_SITE_ID!;
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}${path}`;
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
}

async function graphFetchAbsolute(url: string, init?: RequestInit): Promise<Response> {
  const token = await getGraphToken();
  return fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
}

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

// ---------------------------------------------------------------------------
// Sharing-link helpers (mirrors lib/sharepoint.ts — kept local to avoid coupling)
// ---------------------------------------------------------------------------

function encodeSharingUrl(url: string): string {
  const b64 = Buffer.from(url).toString("base64");
  return "u!" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isSharingLink(url: string): boolean {
  return url.startsWith("http") && (/\/:[\w!]:\//.test(url) || /\/s\/[A-Za-z0-9_-]{10,}/.test(url));
}

// ---------------------------------------------------------------------------
// Resolve a matter folder path to a concrete drive location for writes.
// Sharing links must be resolved to driveId + itemId so we can write via
// /drives/{driveId}/items/{itemId}:/{filename}:/content instead of the
// root:/ path format, which fails when the path is a full sharing URL.
// Result is cached in-memory keyed by the input path.
// ---------------------------------------------------------------------------

type FolderRef =
  | { kind: "drive"; driveId: string; itemId: string }
  | { kind: "site"; relPath: string };

const _folderRefCache = new Map<string, FolderRef>();

async function resolveFolderRef(matterFolderPath: string): Promise<FolderRef> {
  const cached = _folderRefCache.get(matterFolderPath);
  if (cached) return cached;

  if (isSharingLink(matterFolderPath)) {
    const shareId = encodeSharingUrl(matterFolderPath);
    const token = await getGraphToken();
    const res = await graphFetchAbsolute(
      `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem?$select=id,parentReference`,
      undefined
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cannot resolve sharing link ${res.status}: ${text.slice(0, 300)}`);
    }
    const item = await res.json() as { id: string; parentReference?: { driveId?: string } };
    const driveId = item.parentReference?.driveId;
    if (!driveId) throw new Error("Sharing link resolved but driveId missing from parentReference");
    console.log(`[resolveFolderRef] sharing link → driveId=${driveId} itemId=${item.id}`);
    const ref: FolderRef = { kind: "drive", driveId, itemId: item.id };
    _folderRefCache.set(matterFolderPath, ref);
    return ref;
  }

  // Plain relative path — use site drive root:/ format
  const relPath = matterFolderPath.replace(/^\/+/, "").replace(/\/+$/, "");
  const ref: FolderRef = { kind: "site", relPath };
  _folderRefCache.set(matterFolderPath, ref);
  return ref;
}

// ---------------------------------------------------------------------------
// uploadFileToSharePoint — kept for inventory DOCX upload (uses plain path)
// ---------------------------------------------------------------------------
export async function uploadFileToSharePoint(
  remotePath: string,
  filename: string,
  fileBuffer: Buffer,
  mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
): Promise<string> {
  const token = await getGraphToken();
  const siteId = process.env.SHAREPOINT_SITE_ID!;
  const path = remotePath.endsWith("/") ? remotePath : remotePath + "/";
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${path}${filename}:/content`;

  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType },
    body: fileBuffer as unknown as BodyInit,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[uploadFileToSharePoint] Graph ${res.status} for ${path}${filename}:`, text);
    throw new Error(`Graph upload error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  return data.webUrl || "";
}

// ---------------------------------------------------------------------------
// writeMatterFile — resolves sharing links to the matter's own driveId+itemId
// then writes with the drive-item path format. The `filename` may include
// subfolders (e.g. "AI/file_list.json" or "Drafts/draft.docx"); Graph's
// path-based upload auto-creates missing parent folders, so the AI/ and
// Drafts/ folders are created on first write if absent.
// ---------------------------------------------------------------------------

// Encode each path segment but KEEP the "/" separators so Graph treats them as
// folder boundaries (auto-creating parents). encodeURIComponent on the whole
// string would turn "AI/x.json" into "AI%2Fx.json" — a single bad filename.
function encodeRelPath(relPath: string): string {
  return relPath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export async function writeMatterFile(
  matterFolderPath: string,
  filename: string,
  content: string | Buffer,
  mimeType = "application/json"
): Promise<string> {
  const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  const ref = await resolveFolderRef(matterFolderPath);

  let uploadUrl: string;
  if (ref.kind === "drive") {
    // Write into the matter folder's OWN drive/site, resolved from the sharing link.
    // /drives/{driveId}/items/{folderItemId}:/{AI/filename}:/content
    uploadUrl = `https://graph.microsoft.com/v1.0/drives/${ref.driveId}/items/${ref.itemId}:/${encodeRelPath(filename)}:/content`;
  } else {
    // Plain relative path against the configured root site.
    const siteId = process.env.SHAREPOINT_SITE_ID!;
    const base = ref.relPath ? `${ref.relPath}/${filename}` : filename;
    uploadUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${encodeRelPath(base)}:/content`;
  }

  console.log(`[writeMatterFile] PUT ${uploadUrl.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "")}`);
  const token = await getGraphToken();
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType },
    body: buf as unknown as BodyInit,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[writeMatterFile] Graph ${res.status} for ${filename}:`, text);
    // Invalidate cached folder ref so next call re-resolves (handles token expiry, etc.)
    _folderRefCache.delete(matterFolderPath);
    throw new Error(`Graph write error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  return (data as { webUrl?: string }).webUrl || "";
}

export async function listAiFolder(
  matterFolderPath: string
): Promise<{ name: string; downloadUrl: string; lastModified: string }[]> {
  const ref = await resolveFolderRef(matterFolderPath);
  let res: Response;

  if (ref.kind === "drive") {
    const token = await getGraphToken();
    // List children named "AI" under the matter folder, then list AI's children
    const aiChildUrl = `https://graph.microsoft.com/v1.0/drives/${ref.driveId}/items/${ref.itemId}:/AI:/children`;
    res = await graphFetchAbsolute(aiChildUrl);
  } else {
    const path = ref.relPath ? `${ref.relPath}/AI` : "AI";
    res = await graphFetch(`/drive/root:/${path}:/children`);
  }

  if (res.status === 404) return [];
  if (!res.ok) return [];
  const data = await res.json() as { value?: { name: string; "@microsoft.graph.downloadUrl": string; lastModifiedDateTime: string }[] };
  const items = data.value ?? [];
  return items.map((i) => ({
    name: i.name,
    downloadUrl: i["@microsoft.graph.downloadUrl"] ?? "",
    lastModified: i.lastModifiedDateTime,
  }));
}
