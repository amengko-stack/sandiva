import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const io = vi.hoisted(() => ({
  bytes: new Map<string, string>(),
  get: vi.fn(),
  put: vi.fn(),
  requests: [] as Array<{ input: string; init?: RequestInit }>,
}));

vi.mock("@vercel/blob", () => ({ get: io.get, put: io.put }));

import { POST as approveRoute } from "@/app/api/memory/approve/route";
import {
  approveDraftForMemory,
  MISSING_LITIGATION_SESSION_ERROR,
} from "@/components/stages/stage5-memory-approval";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SENTINEL = "STAGE5_SAME_MATTER_SENTINEL_9137 ".repeat(12);
const REGISTRATION_KEY = `litigation-memory/sessions/${SESSION_ID}/litigation-registration.json`;

const approvalInput = (sessionId: string) => ({
  sessionId,
  draftText: SENTINEL,
  docType: "gugatan",
  claimType: "wanprestasi",
  ref: "LIT-C3-A",
});

function seedRegistration() {
  io.bytes.set(REGISTRATION_KEY, JSON.stringify({
    version: 1,
    status: "active",
    sessionId: SESSION_ID,
    root: "https://sandiva.sharepoint.com/sites/Matters/Shared%20Documents/Alpha",
    driveId: "driveA",
    itemId: "rootA",
    createdAt: "2026-09-04T00:00:00.000Z",
  }));
}

async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  io.requests.push({ input: String(input), init });
  return approveRoute(new NextRequest(`http://localhost${String(input)}`, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  }));
}

function matterMemoryEntries() {
  return Array.from(io.bytes.entries()).filter(([key]) =>
    /^litigation-memory\/matter-memory\/[a-f0-9]{64}\//.test(key)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  io.bytes.clear();
  io.requests.length = 0;
  seedRegistration();

  io.get.mockImplementation(async (path: string) => {
    const value = io.bytes.get(path);
    return value === undefined
      ? null
      : { statusCode: 200, stream: new Response(value).body };
  });
  io.put.mockImplementation(async (path: string, body: BodyInit) => {
    const value = typeof body === "string" ? body : await new Response(body).text();
    io.bytes.set(path, value);
    return { url: path };
  });
  vi.stubGlobal("fetch", routeFetch);
});

describe("Stage 5 production memory approval caller", () => {
  it("passes the exact current Litigation session to the real route and writes only matter-scoped memory", async () => {
    await approveDraftForMemory(approvalInput(SESSION_ID));

    expect(io.requests).toHaveLength(1);
    expect(io.requests[0].input).toBe("/api/memory/approve");
    expect(JSON.parse(String(io.requests[0].init?.body))).toEqual({
      sessionId: SESSION_ID,
      draftText: SENTINEL,
      docType: "gugatan",
      claimType: "wanprestasi",
      ref: "LIT-C3-A",
    });

    const scoped = matterMemoryEntries();
    expect(scoped).toHaveLength(3);
    expect(scoped.map(([key]) => key)).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/style_examples\/[0-9a-f-]{36}\.json$/),
      expect.stringMatching(/\/style_examples\/index\.json$/),
      expect.stringMatching(/\/case_patterns\.json$/),
    ]));
    expect(scoped.map(([, value]) => value).join("\n")).toContain(SENTINEL.trim());
    expect(Array.from(io.bytes.keys()).some((key) =>
      key === "litigation-memory/style_examples/index.json" ||
      key === "litigation-memory/case_patterns.json" ||
      key.startsWith("litigation-memory/firm-safe/")
    )).toBe(false);
  });

  it("fails visibly before issuing a request when the workflow has no current session", async () => {
    await expect(approveDraftForMemory(approvalInput(undefined as unknown as string))).rejects.toThrow(
      MISSING_LITIGATION_SESSION_ERROR
    );

    expect(io.requests).toHaveLength(0);
    expect(matterMemoryEntries()).toHaveLength(0);
  });

  it("does not bypass the route for a malformed session", async () => {
    await expect(approveDraftForMemory(approvalInput("not-a-session"))).rejects.toThrow(
      "Akses matter ditolak"
    );
    expect(matterMemoryEntries()).toHaveLength(0);
  });

  it("does not bypass the route for an unregistered session", async () => {
    await expect(approveDraftForMemory(approvalInput("22222222-2222-4222-8222-222222222222"))).rejects.toThrow(
      "Akses matter ditolak"
    );
    expect(matterMemoryEntries()).toHaveLength(0);
  });

  it("does not bypass the route after the current session is cleared", async () => {
    io.bytes.delete(REGISTRATION_KEY);
    await expect(approveDraftForMemory(approvalInput(SESSION_ID))).rejects.toThrow(
      "Akses matter ditolak"
    );
    expect(matterMemoryEntries()).toHaveLength(0);
  });
});
