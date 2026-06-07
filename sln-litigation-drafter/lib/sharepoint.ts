import Anthropic from "@anthropic-ai/sdk";
import type { FileEntry } from "@/types";

const MCP_SERVER = {
  type: "url" as const,
  url: "https://microsoft365.mcp.claude.com/mcp",
  name: "microsoft365",
};

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function mcpQuery(
  instruction: string,
  systemPrompt?: string
): Promise<string> {
  const client = getClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    messages: [{ role: "user", content: instruction }],
    mcp_servers: [MCP_SERVER],
    betas: ["mcp-client-2025-04-04"],
  };

  if (systemPrompt) {
    params.system = systemPrompt;
  }

  const response = await client.beta.messages.create(params);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textBlocks = (response.content as any[]).filter((b: any) => b.type === "text");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return textBlocks.map((b: any) => b.text as string).join("\n").trim();
}

export async function listMatterFiles(folderPath: string): Promise<FileEntry[]> {
  const instruction = `
List ALL files recursively inside the SharePoint folder: "${folderPath}"
Include files in all subfolders. Return ONLY a JSON array, no other text. Format:
[
  { "name": "filename.docx", "path": "full/path/to/file.docx", "size": "45 KB", "type": "docx" },
  ...
]
Include docx, pdf, doc, txt files only. Skip folders, images, and system files.
`;

  const raw = await mcpQuery(
    instruction,
    "You are a SharePoint file listing assistant. Return only valid JSON arrays, no markdown, no explanation."
  );

  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array found");
    const files = JSON.parse(match[0]);
    return files.map((f: Record<string, string>, i: number) => ({
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
  const instruction = `
Read the full text content of this SharePoint file: "${filePath}"
Return the complete text content of the document. Do not summarize. Do not truncate.
If it is a PDF or DOCX, extract all readable text.
`;
  return await mcpQuery(
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
