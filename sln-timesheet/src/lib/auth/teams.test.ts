import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT, type KeyLike } from "jose";
import { verifyTeamsTokenWith } from "./teams";

const TENANT = "tid-123";
const CLIENT = "cid-456";
const BASE = "https://app.example.com";
const ISS = `https://login.microsoftonline.com/${TENANT}/v2.0`;

describe("verifyTeamsTokenWith", () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  });

  beforeEach(() => {
    process.env.ENTRA_TENANT_ID = TENANT;
    process.env.ENTRA_CLIENT_ID = CLIENT;
    process.env.APP_BASE_URL = BASE;
  });

  afterEach(() => {
    delete process.env.ENTRA_TENANT_ID;
    delete process.env.ENTRA_CLIENT_ID;
    delete process.env.APP_BASE_URL;
  });

  function makeToken(
    claims: Record<string, unknown>,
    opts: { iss?: string; aud?: string; exp?: string } = {},
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .setIssuer(opts.iss ?? ISS)
      .setAudience(opts.aud ?? CLIENT)
      .sign(privateKey);
  }

  it("accepts a valid token with preferred_username", async () => {
    const token = await makeToken({ tid: TENANT, preferred_username: "User@Example.com" });
    expect(await verifyTeamsTokenWith(token, publicKey)).toBe("user@example.com");
  });

  it("accepts the api://host/clientId audience", async () => {
    const token = await makeToken(
      { tid: TENANT, preferred_username: "user@example.com" },
      { aud: `api://app.example.com/${CLIENT}` },
    );
    expect(await verifyTeamsTokenWith(token, publicKey)).toBe("user@example.com");
  });

  it("rejects wrong audience", async () => {
    const token = await makeToken(
      { tid: TENANT, preferred_username: "user@example.com" },
      { aud: "someone-else" },
    );
    expect(await verifyTeamsTokenWith(token, publicKey)).toBeNull();
  });

  it("rejects wrong issuer", async () => {
    const token = await makeToken(
      { tid: TENANT, preferred_username: "user@example.com" },
      { iss: "https://login.microsoftonline.com/other-tenant/v2.0" },
    );
    expect(await verifyTeamsTokenWith(token, publicKey)).toBeNull();
  });

  it("rejects tid mismatch", async () => {
    const token = await makeToken({ tid: "different-tid", preferred_username: "user@example.com" });
    expect(await verifyTeamsTokenWith(token, publicKey)).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = await makeToken(
      { tid: TENANT, preferred_username: "user@example.com" },
      { exp: "-10s" },
    );
    expect(await verifyTeamsTokenWith(token, publicKey)).toBeNull();
  });

  it("rejects a token with no usable email claim", async () => {
    const token = await makeToken({ tid: TENANT });
    expect(await verifyTeamsTokenWith(token, publicKey)).toBeNull();
  });

  it("falls back to upn when preferred_username is absent", async () => {
    const token = await makeToken({ tid: TENANT, upn: "Upn.User@Example.com" });
    expect(await verifyTeamsTokenWith(token, publicKey)).toBe("upn.user@example.com");
  });
});
