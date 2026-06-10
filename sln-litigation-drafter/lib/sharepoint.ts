import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import type { FileEntry, DocDocumentType, DocCategory } from "@/types";
import { MODELS } from "@/config/models";

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
    model: MODELS.extraction,
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

async function downloadBytes(filePath: string): Promise<{ bytes: Buffer; ext: string }> {
  if (filePath.startsWith("drive:")) {
    const parts = filePath.split(":");
    const driveId = parts[1];
    const itemId = parts[2];
    const metaRes = await graphFetch(`/drives/${driveId}/items/${itemId}?$select=name`);
    if (!metaRes.ok) {
      const text = await metaRes.text();
      throw new Error(`Drive item metadata error ${metaRes.status}: ${text}`);
    }
    const meta = await metaRes.json();
    const ext = fileExt(meta.name ?? "");
    const contentRes = await graphFetch(`/drives/${driveId}/items/${itemId}/content`);
    if (!contentRes.ok) {
      const text = await contentRes.text();
      throw new Error(`Drive item download error ${contentRes.status}: ${text}`);
    }
    return { bytes: Buffer.from(await contentRes.arrayBuffer()), ext };
  }

  const parsed = await parseInput(filePath);

  if (parsed.kind === "sharing-link") {
    const metaRes = await graphFetch(`/shares/${parsed.shareId}/driveItem?$select=name`);
    if (!metaRes.ok) {
      const text = await metaRes.text();
      throw new Error(`Share metadata error ${metaRes.status}: ${text}`);
    }
    const meta = await metaRes.json();
    const ext = fileExt(meta.name ?? "");
    const contentRes = await graphFetch(`/shares/${parsed.shareId}/driveItem/content`);
    if (!contentRes.ok) {
      const text = await contentRes.text();
      throw new Error(`Share download error ${contentRes.status}: ${text}`);
    }
    return { bytes: Buffer.from(await contentRes.arrayBuffer()), ext };
  }

  const siteId = parsed.siteAddr!;
  const normalized = normalizePath(parsed.folderPath);
  const ext = fileExt(normalized);
  const encoded = encodedSegments(normalized);
  const contentRes = await graphFetch(`/sites/${siteId}/drive/root:/${encoded}:/content`);
  if (!contentRes.ok) {
    const text = await contentRes.text();
    throw new Error(`File download error ${contentRes.status} [${filePath}]: ${text}`);
  }
  return { bytes: Buffer.from(await contentRes.arrayBuffer()), ext };
}

export async function readFileContent(filePath: string): Promise<string> {
  const { bytes, ext } = await downloadBytes(filePath);
  return extractText(bytes, ext);
}

export async function readFileContentWithMode(
  filePath: string,
  documentType: DocDocumentType
): Promise<string> {
  const { bytes, ext } = await downloadBytes(filePath);
  const rawText = await extractText(bytes, ext);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  if (documentType === "perjanjian_kontrak") {
    const res = await anthropic.messages.create({
      model: MODELS.extraction,
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `Dari dokumen perjanjian/kontrak berikut, ekstrak secara terstruktur:\n- Para pihak (nama lengkap dan perannya)\n- Tanggal perjanjian\n- Kewajiban masing-masing pihak\n- Klausul wanprestasi dan konsekuensinya\n- Klausul penalti / denda\n- Nilai perjanjian\n\nDokumen:\n${rawText}`,
        },
      ],
    });
    return res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("\n");
  }

  if (documentType === "bukti_transaksi" || documentType === "dokumen_korporasi") {
    const prompt =
      documentType === "bukti_transaksi"
        ? `Dari dokumen bukti transaksi berikut, buat ringkasan singkat yang mencakup: jumlah/nilai, tanggal transaksi, para pihak, dan deskripsi transaksi.\n\nDokumen:\n${rawText}`
        : `Dari dokumen korporasi berikut, buat ringkasan singkat yang mencakup: nama entitas, struktur kepemilikan, direktur/komisaris, dan data relevan lainnya.\n\nDokumen:\n${rawText}`;
    const res = await anthropic.messages.create({
      model: MODELS.extraction,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    return res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("\n");
  }

  // linear: putusan_penetapan, surat_menyurat, tidak_dikenali — return full text
  return rawText;
}

// ---------------------------------------------------------------------------
// Lightweight metadata lookup (for cache validation) — single $select call
// ---------------------------------------------------------------------------
export async function getFileLastModified(filePath: string): Promise<string | null> {
  try {
    if (filePath.startsWith("drive:")) {
      const [, driveId, itemId] = filePath.split(":");
      const res = await graphFetch(`/drives/${driveId}/items/${itemId}?$select=lastModifiedDateTime`);
      if (!res.ok) return null;
      const meta = await res.json();
      return meta.lastModifiedDateTime ?? null;
    }
    const parsed = await parseInput(filePath);
    if (parsed.kind === "sharing-link") {
      const res = await graphFetch(`/shares/${parsed.shareId}/driveItem?$select=lastModifiedDateTime`);
      if (!res.ok) return null;
      const meta = await res.json();
      return meta.lastModifiedDateTime ?? null;
    }
    const encoded = encodedSegments(normalizePath(parsed.folderPath));
    const res = await graphFetch(`/sites/${parsed.siteAddr}/drive/root:/${encoded}?$select=lastModifiedDateTime`);
    if (!res.ok) return null;
    const meta = await res.json();
    return meta.lastModifiedDateTime ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tiered extraction — depth determined by 2B category
//   KRITIS:    full (PDF capped at 80k chars); contracts by filename get
//              structured extraction labeled [Ekstraksi Terstruktur]
//   PENDUKUNG: first 30.000 chars, labeled if truncated
//   REFERENSI: first 5.000 chars, labeled [Ekstraksi Ringkas]
// ---------------------------------------------------------------------------
const CONTRACT_FILENAME_RE = /perjanjian|pks|nda|akta|kontrak/i;
const PDF_KRITIS_CHAR_CAP = 80_000;
const PENDUKUNG_CHAR_CAP = 30_000;
const REFERENSI_CHAR_CAP = 5_000;

// Avg chars/page below this ⇒ treat as scanned (image) PDF needing external OCR
const SCANNED_CHARS_PER_PAGE = 100;

// ---------------------------------------------------------------------------
// PDF handling — local text extraction + scanned detection (no in-app OCR)
// ---------------------------------------------------------------------------

interface SmartPdfResult { text: string; method: string; needsOcr: boolean; pagesRead: number }

// Local PDF text extraction via unpdf — built for serverless Node, zero
// browser/DOM dependencies (no DOMMatrix). Single extraction path for all
// categories. Extracts all text in one call; we slice to charCap afterwards.
async function extractPdfTextPaged(
  bytes: Buffer,
  charCap: number
): Promise<{ text: string; pagesRead: number }> {
  const { extractText: unpdfExtractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text: fullText, totalPages } = await unpdfExtractText(pdf, { mergePages: true });
  const merged = typeof fullText === "string" ? fullText : (fullText as string[]).join("\n");
  const text = merged.length > charCap ? merged.slice(0, charCap) : merged;
  return { text, pagesRead: totalPages ?? 1 };
}

// Decide text vs scanned. A scanned (image) PDF with no text layer is NOT
// OCR'd in-app — it is flagged needsOcr so the drafter can OCR it externally
// (Acrobat / SharePoint re-save) and re-check. Detection is instant.
async function extractPdfSmart(bytes: Buffer, charCap: number, fileName: string): Promise<SmartPdfResult> {
  const { text, pagesRead } = await extractPdfTextPaged(bytes, charCap);
  // Use raw (pre-cap) length for detection so a partially-capped text PDF isn't misclassified.
  const rawLen = text.length;
  const avgPerPage = pagesRead > 0 ? rawLen / pagesRead : 0;
  console.log(`[extractPdfSmart] ${fileName}: ${pagesRead} pages, ${rawLen} chars, avg ${avgPerPage.toFixed(1)} chars/page → ${avgPerPage >= SCANNED_CHARS_PER_PAGE ? "TEXT" : "PERLU_OCR"}`);

  if (avgPerPage >= SCANNED_CHARS_PER_PAGE) {
    const capped = text.length > charCap ? text.slice(0, charCap) : text;
    return { text: capped, method: "pdf_text", needsOcr: false, pagesRead };
  }

  // Scanned (image) PDF — no text layer. Flag for external OCR; do not extract.
  return { text: "", method: "perlu_ocr", needsOcr: true, pagesRead };
}

async function structuredContractExtract(rawText: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await anthropic.messages.create({
    model: MODELS.extraction,
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: `Dari dokumen perjanjian/kontrak berikut, ekstrak secara terstruktur:
- Para pihak (nama lengkap dan perannya)
- Kewajiban masing-masing pihak (kutip verbatim klausul kewajiban)
- Ketentuan pembayaran (nilai, jadwal, metode)
- Ketentuan pengakhiran perjanjian
- Penyelesaian sengketa (forum, hukum yang berlaku)
- Klausul penalti / denda (kutip verbatim)

Dokumen:
${rawText}`,
      },
    ],
  });
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

export async function extractWithTier(
  filePath: string,
  fileName: string,
  category: DocCategory
): Promise<{ content: string; extractionMethod: string; needsOcr?: boolean }> {
  const { bytes, ext } = await downloadBytes(filePath);

  const charCap =
    category === "KRITIS" ? PDF_KRITIS_CHAR_CAP : category === "PENDUKUNG" ? PENDUKUNG_CHAR_CAP : REFERENSI_CHAR_CAP;

  // PDFs: local text extraction + scanned detection. A scanned PDF with no text
  // layer is flagged needsOcr (external OCR required) and short-circuits here.
  // Any failure is left to propagate to the per-file catch in the route (marks gagal).
  if (ext === "pdf") {
    const smart = await extractPdfSmart(bytes, charCap, fileName);
    if (smart.needsOcr) {
      return { content: "", extractionMethod: "perlu_ocr", needsOcr: true };
    }
    const raw = smart.text;

    if (category === "KRITIS") {
      // Contracts: structured extraction over text PDFs.
      if (CONTRACT_FILENAME_RE.test(fileName)) {
        const structured = await structuredContractExtract(raw);
        return { content: `[Ekstraksi Terstruktur]\n${structured}`, extractionMethod: "structured" };
      }
      return { content: raw, extractionMethod: smart.method };
    }

    if (category === "PENDUKUNG") {
      // raw is already capped at PENDUKUNG_CHAR_CAP by extractPdfSmart
      return { content: raw, extractionMethod: "pdf_text" };
    }

    // REFERENSI — already capped at 5k
    return { content: `[Ekstraksi Ringkas]\n${raw}`, extractionMethod: smart.method };
  }

  // DOCX / DOC / TXT — text-only via mammoth/utf-8; never gated by size
  const raw = await extractText(bytes, ext);

  if (category === "KRITIS") {
    if (CONTRACT_FILENAME_RE.test(fileName)) {
      const structured = await structuredContractExtract(raw);
      return { content: `[Ekstraksi Terstruktur]\n${structured}`, extractionMethod: "structured" };
    }
    return { content: raw, extractionMethod: "full" };
  }

  if (category === "PENDUKUNG") {
    if (raw.length > PENDUKUNG_CHAR_CAP) {
      return {
        content:
          raw.slice(0, PENDUKUNG_CHAR_CAP) +
          `\n[Terpotong — ${PENDUKUNG_CHAR_CAP.toLocaleString("id-ID")} karakter pertama dari ${raw.length.toLocaleString("id-ID")}]`,
        extractionMethod: "truncated_30k",
      };
    }
    return { content: raw, extractionMethod: "full" };
  }

  // REFERENSI
  return {
    content: `[Ekstraksi Ringkas]\n${raw.slice(0, REFERENSI_CHAR_CAP)}`,
    extractionMethod: "summary_5k",
  };
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
