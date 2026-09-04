import { getGraphToken } from "@/lib/sharepoint";
import { normalizeLitigationRoot, requireOutputTarget } from "@/lib/litigation-paths";
import type { FileEntry } from "@/types";

export interface MatterLocation { driveId: string; itemId: string }
const GRAPH = "https://graph.microsoft.com/v1.0";
const safeId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9!_-]+$/.test(id);
type Item = { id: string; name: string; size?: number; folder?: object; file?: object; remoteItem?: object; parentReference?: { driveId?: string }; webUrl?: string; "@microsoft.graph.downloadUrl"?: string; lastModifiedDateTime?: string };

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GRAPH}${path}`, { ...init, cache: "no-store", headers: { ...init?.headers, Authorization: `Bearer ${await getGraphToken()}` } });
}
async function getJson(path: string) {
  const response = await request(path);
  if (!response.ok) throw new Error("SharePoint operation failed");
  return response.json();
}
async function pages(path: string): Promise<Item[]> {
  const output: Item[] = [];
  let next: string | undefined = path;
  const collection = new URL(`${GRAPH}${path}`).pathname;
  const seen = new Set<string>();
  while (next) {
    if (seen.has(next)) throw new Error("Invalid pagination");
    seen.add(next);
    const data = await getJson(next);
    if (!Array.isArray(data.value)) throw new Error("Invalid listing");
    output.push(...data.value);
    next = undefined;
    if (data["@odata.nextLink"]) {
      const url = new URL(data["@odata.nextLink"]);
      if (url.origin !== "https://graph.microsoft.com" || url.pathname !== collection || url.hash || url.username || url.password) throw new Error("Invalid pagination");
      next = `${url.pathname.slice("/v1.0".length)}${url.search}`;
    }
  }
  return output;
}
function location(item: Item, expectedDrive?: string): MatterLocation {
  const driveId = item.parentReference?.driveId ?? expectedDrive;
  if (!item.folder || item.remoteItem || !safeId(item.id) || !safeId(driveId) || (expectedDrive && expectedDrive !== driveId)) throw new Error("Invalid matter folder");
  return { driveId, itemId: item.id };
}

// Only the explicit registration endpoint calls this. Ordinary protected
// routes compare the stored root first and use its persisted drive location.
export async function resolveMatterRoot(input: string): Promise<MatterLocation> {
  const root = normalizeLitigationRoot(input);
  if (root.includes("/:f:/")) {
    const shareId = `u!${Buffer.from(root).toString("base64url")}`;
    return location(await getJson(`/shares/${shareId}/driveItem?$select=id,folder,parentReference,remoteItem`));
  }
  let siteId: string;
  let relative: string[];
  let libraryUrl: string | undefined;
  if (root.startsWith("https://")) {
    const url = new URL(root);
    const segments = url.pathname.slice(1).split("/");
    const site = await getJson(`/sites/${url.hostname}:/${segments[0]}/${segments[1]}?$select=id`);
    if (typeof site.id !== "string" || !/^[A-Za-z0-9.,_-]+$/.test(site.id)) throw new Error("Invalid site");
    siteId = site.id;
    libraryUrl = `${url.origin}/${segments.slice(0, 3).join("/")}`;
    relative = segments.slice(3);
  } else {
    const segments = root.split("/");
    // Preserve the explicit Site/Shared Documents/folder shorthand. Other
    // relative paths address the configured default drive without guessing a site.
    if (segments.length >= 3 && segments[1] === "Shared%20Documents") {
      return resolveMatterRoot(`https://${process.env.SHAREPOINT_HOSTNAME ?? "sandiva.sharepoint.com"}/sites/${segments[0]}/${segments.slice(1).join("/")}`);
    }
    siteId = process.env.SHAREPOINT_SITE_ID ?? "";
    if (!/^[A-Za-z0-9.,_-]+$/.test(siteId)) throw new Error("Invalid configured site");
    relative = segments[0] === "Shared%20Documents" ? segments.slice(1) : segments;
  }
  let driveId: string;
  if (libraryUrl) {
    const drives = await pages(`/sites/${siteId}/drives?$select=id,webUrl`);
    const matches = drives.filter((d) => {
      try { return d.webUrl && normalizeLitigationRoot(`${d.webUrl}/__library__`).replace(/\/__library__$/, "") === libraryUrl; }
      catch { return false; }
    });
    if (matches.length !== 1) throw new Error("Invalid library");
    driveId = matches[0].id;
  } else {
    driveId = (await getJson(`/sites/${siteId}/drive?$select=id`)).id;
  }
  if (!safeId(driveId) || !relative.length) throw new Error("Invalid matter root");
  return location(await getJson(`/drives/${driveId}/root:/${relative.join("/")}?$select=id,folder,parentReference,remoteItem`), driveId);
}

const itemBase = (root: MatterLocation) => {
  if (!safeId(root.driveId) || !safeId(root.itemId)) throw new Error("Invalid location");
  return `/drives/${root.driveId}/items/${root.itemId}`;
};
export async function listMatterFiles(root: MatterLocation): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  const visited = new Set<string>();
  async function visit(itemId: string, folder: string) {
    if (visited.has(itemId)) throw new Error("Invalid folder cycle");
    visited.add(itemId);
    const items = await pages(`${itemBase({ ...root, itemId })}/children?$select=id,name,size,file,folder,parentReference,remoteItem`);
    for (const item of items) {
      if (item.remoteItem) continue; // shortcuts do not widen this matter
      if (!safeId(item.id) || typeof item.name !== "string" || /[/\\\u0000-\u001f]/.test(item.name) || (item.parentReference?.driveId && item.parentReference.driveId !== root.driveId)) throw new Error("Invalid child identity");
      if (item.folder) await visit(item.id, folder ? `${folder}/${item.name}` : item.name);
      else if (item.file) {
        const type = item.name.split(".").pop()?.toLowerCase() ?? "";
        if (["pdf", "docx", "doc", "txt"].includes(type)) files.push({
          id: item.id, name: item.name, path: `drive:${root.driveId}:${item.id}`,
          folder, type, size: item.size ? `${Math.round(item.size / 1024)} KB` : "", selected: true,
        });
      }
    }
  }
  await visit(root.itemId, "");
  return files;
}
export async function writeMatterFile(root: MatterLocation, filename: string, content: string | Buffer, mimeType = "application/json"): Promise<string> {
  requireOutputTarget(filename, ["AI", "Drafts"]);
  const encoded = filename.split("/").map(encodeURIComponent).join("/");
  const response = await request(`${itemBase(root)}:/${encoded}:/content`, { method: "PUT", headers: { "Content-Type": mimeType }, body: content as BodyInit });
  if (!response.ok) throw new Error("SharePoint write failed");
  return (await response.json()).webUrl ?? "";
}
export async function listAiFolder(root: MatterLocation): Promise<{ name: string; downloadUrl: string; lastModified: string }[]> {
  const path = `${itemBase(root)}:/AI:/children?$select=id,name,file,remoteItem,lastModifiedDateTime,@microsoft.graph.downloadUrl`;
  // A missing AI folder is the normal first-session state.
  const first = await request(path);
  if (first.status === 404) return [];
  if (!first.ok) throw new Error("SharePoint listing failed");
  const data = await first.json();
  if (!Array.isArray(data.value)) throw new Error("Invalid listing");
  let items: Item[] = data.value;
  if (data["@odata.nextLink"]) {
    const next = new URL(data["@odata.nextLink"]);
    if (next.origin !== "https://graph.microsoft.com" || next.pathname !== new URL(`${GRAPH}${path}`).pathname || next.hash) throw new Error("Invalid pagination");
    items = items.concat(await pages(`${next.pathname.slice(5)}${next.search}`));
  }
  return items.filter((i) => i.file && !i.remoteItem).map((i) => ({ name: i.name, downloadUrl: i["@microsoft.graph.downloadUrl"] ?? "", lastModified: i.lastModifiedDateTime ?? "" }));
}
