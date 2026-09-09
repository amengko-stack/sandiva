import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

let agent: MockAgent;
const originalDispatcher = getGlobalDispatcher();
beforeEach(() => {
  agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  vi.stubEnv("VERCEL_BLOB_RETRIES", "0");
});
afterEach(async () => { setGlobalDispatcher(originalDispatcher); await agent.close(); vi.unstubAllEnvs(); });
describe("H-12 installed SDK transport with unmatched network denied", () => {
  it("forwards the exact ETag and deterministic create-only flags", async () => {
    const requests: unknown[] = [];
    const response = { url: "https://synthetic.private.blob.vercel-storage.com/test.json", pathname: "test.json", contentType: "application/json", contentDisposition: "inline", etag: '"v2"' };
    agent.get(/.*/).intercept({ path: /.*/, method: "PUT" }).reply(options => { requests.push(options.headers); return { statusCode: 200, data: response }; }).times(2);
    const opts = { access: "private" as const, token: "vercel_blob_rw_synthetic_FAKE_LOCAL_ONLY", addRandomSuffix: false };
    const result = await put("test.json", "[]", { ...opts, allowOverwrite: true, ifMatch: '"v1"' });
    expect(result.etag).toBe('"v2"');
    expect(new Headers(requests[0] as HeadersInit).get("x-if-match")).toBe('"v1"');
    await put("new.json", "[]", { ...opts, allowOverwrite: false });
    const headers = new Headers(requests[1] as HeadersInit);
    expect(headers.get("x-allow-overwrite")).toBe("0"); expect(headers.get("x-add-random-suffix")).toBe("0");
    expect(headers.get("x-if-match")).toBeNull();
  });
  it("surfaces storage precondition failure without retrying a conflict", async () => {
    let calls = 0;
    agent.get(/.*/).intercept({ path: /.*/, method: "PUT" }).reply(() => { calls++; return { statusCode: 412, data: { error: { code: "precondition_failed" } } }; });
    await expect(put("test.json", "[]", { access: "private", token: "vercel_blob_rw_synthetic_FAKE_LOCAL_ONLY", allowOverwrite: true, ifMatch: '"v1"' })).rejects.toBeInstanceOf(BlobPreconditionFailedError);
    expect(calls).toBe(1);
  });
  it("returns body and ETag together, actual404 as null, and auth error as failure", async () => {
    const pool = agent.get(/.*/);
    pool.intercept({ path: /test.json/, method: "GET" }).reply(200, "[]", { headers: { etag: '"v1"' } });
    pool.intercept({ path: /missing.json/, method: "GET" }).reply(404);
    pool.intercept({ path: /forbidden.json/, method: "GET" }).reply(403);
    const opts = { access: "private" as const, token: "vercel_blob_rw_synthetic_FAKE_LOCAL_ONLY", useCache: false };
    const r = await get("test.json", opts);
    expect(r?.blob.etag).toBe('"v1"'); expect(await new Response(r!.stream).text()).toBe("[]");
    expect(await get("missing.json", opts)).toBeNull();
    await expect(get("forbidden.json", opts)).rejects.toThrow();
    agent.assertNoPendingInterceptors();
  });
  it("denies an unregistered request locally instead of contacting a provider", async () => {
    await expect(get("unregistered.json", { access: "private", token: "vercel_blob_rw_synthetic_FAKE_LOCAL_ONLY", useCache: false })).rejects.toThrow();
  });
});
