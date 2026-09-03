// Litigation-only canonicalization. Do not substitute the LDD matter guard:
// it intentionally has a different trust model. Preserve path/token case.
export function normalizeLitigationRoot(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid root");
  const raw = value.trim();
  if (!raw || /[\\\u0000-\u001f\u007f#<>]/.test(raw)) throw new Error("Invalid root");
  const parts = raw.split("?");
  if (parts.length > 2) throw new Error("Invalid root");
  const path = parts[0].replace(/\/+$/, "");
  // Validate BEFORE URL parsing, which would silently remove dot segments.
  const scheme = path.startsWith("https://");
  const segments = (scheme ? path.slice(8) : path).split("/");
  const decoded = segments.map((segment) => {
    const s = decodeURIComponent(segment);
    if (!s || s === "." || s === ".." || /[/%\\?#\u0000-\u001f\u007f]/.test(s) || s.trim() !== s || /\.aspx$/i.test(s)) {
      throw new Error("Invalid root");
    }
    return s;
  });
  if (scheme) {
    const host = decoded[0].toLowerCase();
    if (!/^[a-z0-9-]+\.sharepoint\.com$/.test(host)) throw new Error("Invalid host");
    const sharing = decoded[1] === ":f:" && ["s", "r"].includes(decoded[2]);
    if (sharing) {
      if (decoded.length < 5 || (parts[1] !== undefined && !/^e=[A-Za-z0-9_-]+$/.test(parts[1]))) throw new Error("Invalid sharing root");
      return `https://${host}/${decoded.slice(1).map((s, i) => i === 0 ? s : encodeURIComponent(s)).join("/")}${parts[1] ? `?${parts[1]}` : ""}`;
    }
    if (!["sites", "teams"].includes(decoded[1]) || decoded.length < 5 || parts.length !== 1 || decoded.slice(1).some((s) => s.includes(":"))) throw new Error("Invalid site root");
    return `https://${host}/${decoded.slice(1).map(encodeURIComponent).join("/")}`;
  }
  if (parts.length !== 1 || decoded.some((s) => s.includes(":"))) throw new Error("Invalid relative root");
  return decoded.map(encodeURIComponent).join("/");
}

export function isDriveIdentity(value: unknown): value is string {
  return typeof value === "string" && /^drive:[A-Za-z0-9!_-]+:[A-Za-z0-9!_-]+$/.test(value);
}

export function requireOutputTarget(value: unknown, folders: readonly string[]): asserts value is string {
  if (typeof value !== "string" || !/^(AI|Drafts)\/[A-Za-z0-9 ._()À-ɏ-]+$/.test(value) || value.includes("..")) throw new Error("Invalid output");
  const [folder, filename] = value.split("/");
  if (!folders.includes(folder) || filename.trim() !== filename || filename === "." || filename.endsWith(".")) throw new Error("Invalid output");
}
