import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintSessionToken, verifySessionToken } from "./session";

describe("session tokens", () => {
  beforeEach(() => {
    process.env.APP_SESSION_TOKEN = "test-secret";
  });
  afterEach(() => {
    delete process.env.APP_SESSION_TOKEN;
  });

  it("round-trips userId and role", () => {
    const token = mintSessionToken(42, "partner")!;
    const s = verifySessionToken(token);
    expect(s).not.toBeNull();
    expect(s!.userId).toBe(42);
    expect(s!.role).toBe("partner");
    expect(s!.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("rejects tampered role (member cannot promote themselves)", () => {
    const token = mintSessionToken(42, "member")!;
    const parts = token.split(".");
    parts[2] = "admin";
    expect(verifySessionToken(parts.join("."))).toBeNull();
  });

  it("rejects tampered userId", () => {
    const token = mintSessionToken(42, "member")!;
    const parts = token.split(".");
    parts[1] = "1";
    expect(verifySessionToken(parts.join("."))).toBeNull();
  });

  it("rejects expired tokens", () => {
    const token = mintSessionToken(42, "member")!;
    const parts = token.split(".");
    parts[3] = String(Date.now() - 1000);
    expect(verifySessionToken(parts.join("."))).toBeNull();
  });

  it("rejects garbage and missing secret", () => {
    expect(verifySessionToken("nonsense")).toBeNull();
    expect(verifySessionToken(undefined)).toBeNull();
    const token = mintSessionToken(1, "admin")!;
    delete process.env.APP_SESSION_TOKEN;
    expect(verifySessionToken(token)).toBeNull();
  });
});
