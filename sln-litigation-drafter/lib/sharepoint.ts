import Anthropic from "@anthropic-ai/sdk";
import { Client, ResponseType } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import { ClientSecretCredential } from "@azure/identity";
import type { FileEntry } from "@/types";

let _graphClient: Client | null = null;

function getGraphClient(): Client {
  if (_graphClient) return _graphClient;
  const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!
  );
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: ["https://graph.microsoft.com/.default"],
  });
  _graphClient = Client.initWithMiddleware({ authProvider });
  return _graphClient;
}

function getAnthropicClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Resolve a human-readable SharePoint folder path to a Graph drive item path.
// Accepts either "Sites/SiteName/Shared Documents/FolderName" style paths
// or just the relative folder path under the default drive root.
function normalizeFolderPath(folderPath: string): string {
  // Strip leading slash
  return folderPath.replace(/^\/+/, "");
}

interface GraphDriveItem {
  id: string;
  name: string;
  size?: number;
  file?: { mimeType: string };
  folder?: object;
  parentReference?: { path: string };
  "@microsoft.graph.downloadUrl"?: string;
}

const ALLOWED_EXTENSIONS = new Set(["docx", "pdf", "doc", "txt"]);

function ext(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

export async function listMatterFiles(folderPath: string): Promise<FileEntry[]> {
  const client = getGraphClient();
  const siteId = process.env.SHAREPOINT_SITE_ID!;
  const normalized = normalizeFolderPath(folderPath);

  const results: FileEntry[] = [];
  let index = 0;

  async function recurse(path: string) {
    const endpoint = path
      ? `/sites/${siteId}/drive/root:/${path}:/children`
      : `/sites/${siteId}/drive/root/children`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await client
      .api(endpoint)
      .select("id,name,size,file,folder,parentReference")
      .get();

    const items: GraphDriveItem[] = response.value ?? [];

    for (const item of items) {
      if (item.folder) {
        const childPath = path ? `${path}/${item.name}` : item.name;
        await recurse(childPath);
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
  const client = getGraphClient();
  const siteId = process.env.SHAREPOINT_SITE_ID!;
  const normalized = normalizeFolderPath(filePath);
  const fileExt = ext(normalized);

  // Download the raw file bytes
  const endpoint = `/sites/${siteId}/drive/root:/${normalized}:/content`;
  const arrayBuffer: ArrayBuffer = await client
    .api(endpoint)
    .responseType(ResponseType.ARRAYBUFFER)
    .get();
  const bytes = Buffer.from(arrayBuffer);

  // For plain text files return directly
  if (fileExt === "txt") {
    return bytes.toString("utf-8");
  }

  // For DOCX/PDF/DOC, send to Claude as a base64 document for extraction
  const anthropic = getAnthropicClient();
  const mediaType =
    fileExt === "pdf"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
              media_type: mediaType,
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
