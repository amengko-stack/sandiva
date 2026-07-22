import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

// Microsoft Teams tab SSO. The Teams client hands the tab an Entra-issued JWT
// via authentication.getAuthToken() — this is NOT the same OAuth2 authorization-
// code flow as src/lib/auth/entra.ts (there's no browser redirect inside the
// Teams iframe), so it needs its own verification: check the JWT's signature
// against Entra's public keys, then mint the SAME session cookie the browser
// flow mints (src/app/api/auth/teams/route.ts does the minting).

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} environment variable.`);
  return value;
}

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _jwksTenantId: string | null = null;

function remoteJwks(tenantId: string): ReturnType<typeof createRemoteJWKSet> {
  if (_jwks && _jwksTenantId === tenantId) return _jwks;
  _jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
  );
  _jwksTenantId = tenantId;
  return _jwks;
}

/**
 * Verify a Teams-supplied JWT against a caller-provided key source (remote
 * JWKS in production, a local public key in tests) and return the signed-in
 * user's email, or null if the token is invalid/expired/wrong-tenant/has no
 * usable email claim. Invalid/expired/wrong-signature tokens are expected
 * input, not exceptional — callers get null, not a thrown error.
 */
export async function verifyTeamsTokenWith(
  token: string,
  keySource: Parameters<typeof jwtVerify>[1],
): Promise<string | null> {
  const tenantId = requiredEnv("ENTRA_TENANT_ID");
  const clientId = requiredEnv("ENTRA_CLIENT_ID");
  const host = new URL(requiredEnv("APP_BASE_URL")).host;

  let payload;
  try {
    const result = await jwtVerify(token, keySource, {
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: [clientId, `api://${host}/${clientId}`],
    });
    payload = result.payload;
  } catch (err) {
    // Rejected tokens are expected input, but the REASON matters when
    // debugging tenant config (wrong issuer = v1 token, wrong audience =
    // Application ID URI mismatch, ...) — log it for the App Service
    // log stream without leaking anything to the caller.
    console.error(
      "Teams token rejected:",
      err instanceof Error ? `${(err as { code?: string }).code ?? err.name}: ${err.message}` : err,
    );
    return null;
  }

  if (payload.tid !== tenantId) {
    console.error("Teams token rejected: tid mismatch");
    return null;
  }

  const email =
    (payload.preferred_username as string | undefined) ??
    (payload.upn as string | undefined) ??
    (payload.email as string | undefined);
  if (!email) return null;
  return email.toLowerCase().trim();
}

/** Verify a Teams-supplied JWT against Entra's live public keys. */
export async function verifyTeamsToken(token: string): Promise<string | null> {
  const tenantId = requiredEnv("ENTRA_TENANT_ID");
  return verifyTeamsTokenWith(token, remoteJwks(tenantId) as unknown as JWTVerifyGetKey);
}
