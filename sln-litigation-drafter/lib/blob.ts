import { put, get } from "@vercel/blob";
import type { MemoryLibrary, PatternEntry, StyleExample } from "@/types";

const PREFIX = "litigation-memory";

export async function readBlobText(path: string): Promise<string | null> {
  try {
    // Blobs are written with access:"private", so they cannot be read by a
    // plain fetch against a constructed public URL — that returns 403/404.
    // get() authenticates with the token and resolves the private pathname
    // (deterministic, matches the put() pathname since allowOverwrite avoids
    // random suffixes). useCache:false avoids serving a stale/empty object
    // right after a write.
    const result = await get(`${PREFIX}/${path}`, {
      access: "private",
      token: process.env.BLOB_READ_WRITE_TOKEN,
      useCache: false,
    });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return await new Response(result.stream).text();
  } catch (e) {
    console.error(`[blob] readBlobText failed for ${PREFIX}/${path}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export async function writeBlobText(
  path: string,
  content: string
): Promise<string> {
  const { url } = await put(`${PREFIX}/${path}`, content, {
    access: "private",
    token: process.env.BLOB_READ_WRITE_TOKEN,
    allowOverwrite: true,
  });
  return url;
}

export async function conventionsExist(): Promise<boolean> {
  const text = await readBlobText("firm_conventions.md");
  return !!text && text.length > 50;
}

export async function loadMemoryLibrary(): Promise<MemoryLibrary> {
  const [conventionsRaw, patternsRaw, styleIndexRaw] = await Promise.all([
    readBlobText("firm_conventions.md"),
    readBlobText("case_patterns.json"),
    readBlobText("style_examples/index.json"),
  ]);

  const conventions = conventionsRaw ?? "";

  let patterns: MemoryLibrary["patterns"] = { totalDrafts: 0, patterns: [] };
  if (patternsRaw) {
    try {
      patterns = JSON.parse(patternsRaw);
    } catch (e) {
      console.error("[blob] case_patterns.json parse failed, using empty patterns:", e instanceof Error ? e.message : e);
    }
  }

  let styleExamples: StyleExample[] = [];
  if (styleIndexRaw) {
    try {
      const index: { path: string; type: string; claimType: string; label: string }[] =
        JSON.parse(styleIndexRaw);
      const recent = index.slice(-3);
      const loaded = await Promise.all(
        recent.map(async (entry) => {
          const content = await readBlobText(
            `style_examples/${entry.path.split("/").pop()}`
          );
          if (!content || content.length < 200) return null;
          return {
            type: entry.type,
            claimType: entry.claimType,
            label: entry.label,
            content: content.slice(0, 3000),
          } as StyleExample;
        })
      );
      styleExamples = loaded.filter(Boolean) as StyleExample[];
    } catch (e) {
      console.error("[blob] style_examples/index.json load failed, skipping style examples:", e instanceof Error ? e.message : e);
    }
  }

  return { conventions, patterns, styleExamples };
}

export function buildMemoryContext(memory: MemoryLibrary): string {
  let ctx = "";

  if (memory.conventions) {
    ctx += `\n\n=== KONVENSI FIRMA SLN ===\n${memory.conventions}\n`;
  }

  if (memory.patterns.totalDrafts > 0) {
    ctx += `\n=== POLA KASUS (dari ${memory.patterns.totalDrafts} draft sebelumnya) ===\n`;
    const recent = memory.patterns.patterns.slice(-5);
    for (const p of recent) {
      ctx += `- ${p.docType} (${p.claimType}): ${p.note}\n`;
    }
  }

  if (memory.styleExamples.length > 0) {
    ctx += `\n=== CONTOH DRAFT YANG DISETUJUI SLN ===\n`;
    for (const ex of memory.styleExamples) {
      ctx += `\n--- ${ex.label} (${ex.type} / ${ex.claimType}) ---\n`;
      ctx += ex.content + "\n";
    }
  }

  return ctx;
}

export async function saveApprovedDraft(
  draftText: string,
  meta: { docType: string; claimType: string; ref: string }
): Promise<void> {
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `${meta.docType}_${meta.claimType}_${timestamp}.txt`;

  await writeBlobText(`style_examples/${filename}`, draftText);

  const indexRaw = await readBlobText("style_examples/index.json");
  let index: { path: string; type: string; claimType: string; label: string }[] = [];
  if (indexRaw) {
    try {
      index = JSON.parse(indexRaw);
    } catch (e) {
      console.error("[blob] style_examples/index.json parse failed, rebuilding index:", e instanceof Error ? e.message : e);
    }
  }
  index.push({
    path: `style_examples/${filename}`,
    type: meta.docType,
    claimType: meta.claimType,
    label: `${meta.ref} — ${timestamp}`,
  });
  if (index.length > 20) index = index.slice(-20);
  await writeBlobText("style_examples/index.json", JSON.stringify(index, null, 2));

  const patternsRaw = await readBlobText("case_patterns.json");
  let patterns: { totalDrafts: number; patterns: PatternEntry[] } = {
    totalDrafts: 0,
    patterns: [],
  };
  if (patternsRaw) {
    try {
      patterns = JSON.parse(patternsRaw);
    } catch (e) {
      console.error("[blob] case_patterns.json parse failed, resetting patterns:", e instanceof Error ? e.message : e);
    }
  }
  patterns.totalDrafts = (patterns.totalDrafts || 0) + 1;
  patterns.patterns = patterns.patterns || [];
  const note = draftText.split("\n").filter((l) => l.trim().length > 40).slice(0, 2).join(" | ").slice(0, 200);
  patterns.patterns.push({ docType: meta.docType, claimType: meta.claimType, note, date: timestamp });
  if (patterns.patterns.length > 50) patterns.patterns = patterns.patterns.slice(-50);
  await writeBlobText("case_patterns.json", JSON.stringify(patterns, null, 2));
}
