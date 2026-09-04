import { put, get } from "@vercel/blob";

const PREFIX = "litigation-memory";

// sessionId comes from the client and is interpolated into blob keys — reject
// anything that could escape `sessions/<id>/` or collide with another key.
export function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(sessionId);
}

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
