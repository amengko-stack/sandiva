import { put, get, BlobNotFoundError } from "@vercel/blob";

const PREFIX = "litigation-memory";

/** A single strong storage ETag, never a wildcard or a list of preconditions. */
export function isBlobRevision(value: unknown): value is string {
  return typeof value === "string" && /^"[\x21\x23-\x7e]{1,256}"$/.test(value);
}

/** Unlike the legacy convenience reader, errors here are never absence. */
export async function readVersionedBlobText(path: string): Promise<{ text: string; revision: string } | null> {
  let result;
  try {
    result = await get(`${PREFIX}/${path}`, {
      access: "private", token: process.env.BLOB_READ_WRITE_TOKEN, useCache: false,
    });
  } catch (e) {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  }
  // The installed SDK returns null only for an actual HTTP404.
  if (result === null) return null;
  if (!result || result.statusCode !== 200 || !result.stream || !isBlobRevision(result.blob.etag)) {
    throw new Error("Invalid versioned blob response");
  }
  return { text: await new Response(result.stream).text(), revision: result.blob.etag };
}

/** null means create-only, and may be used only after confirmed absence. */
export async function writeVersionedBlobText(path: string, text: string, revision: string | null): Promise<string> {
  if (revision !== null && !isBlobRevision(revision)) throw new Error("Invalid blob revision");
  const result = await put(`${PREFIX}/${path}`, text, {
    access: "private", token: process.env.BLOB_READ_WRITE_TOKEN, addRandomSuffix: false,
    ...(revision === null ? { allowOverwrite: false } : { allowOverwrite: true, ifMatch: revision }),
  });
  // A missing acknowledgement cannot safely be replaced by a separate head read.
  if (!isBlobRevision(result.etag)) throw new Error("Unconfirmed blob revision");
  return result.etag;
}

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
