import crypto from "crypto";
import { ConfidentialClientApplication } from "@azure/msal-node";
import type { AuthenticationResult } from "@azure/msal-node";

// Microsoft Entra ID (single-tenant) sign-in via the OAuth2 authorization-code
// flow. This is the only way session cookies get minted now — the cookie
// itself (src/lib/auth/session.ts) and its validation (middleware.ts) are
// unchanged; Entra just replaces the old email/password front door.

const SCOPES = ["openid", "profile", "email", "User.Read"];

/** Short-lived cookie carrying the OAuth `state` CSRF value between the
 *  /api/auth/entra/login redirect and the /api/auth/entra/callback check. */
export const ENTRA_STATE_COOKIE = "slnts_entra_state";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} environment variable.`);
  return value;
}

let _msal: ConfidentialClientApplication | null = null;

function msalClient(): ConfidentialClientApplication {
  if (_msal) return _msal;
  _msal = new ConfidentialClientApplication({
    auth: {
      clientId: requiredEnv("ENTRA_CLIENT_ID"),
      authority: `https://login.microsoftonline.com/${requiredEnv("ENTRA_TENANT_ID")}`,
      clientSecret: requiredEnv("ENTRA_CLIENT_SECRET"),
    },
  });
  return _msal;
}

function redirectUri(): string {
  return `${requiredEnv("APP_BASE_URL")}/api/auth/entra/callback`;
}

/** Build the Microsoft sign-in URL the browser should be redirected to. */
export async function buildAuthorizationUrl(state: string): Promise<string> {
  return msalClient().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: redirectUri(),
    state,
  });
}

/** Random, unguessable value for the OAuth `state` CSRF check. */
export function randomState(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * Exchange the callback `code` for tokens and return the signed-in user's
 * email. Entra ID tokens carry it as `email` (when the mailbox is verified)
 * or, failing that, `preferred_username` (usually the UPN, which for this
 * tenant is the same address staff sign in with).
 */
export async function acquireEmailByCode(code: string): Promise<string | null> {
  const result: AuthenticationResult | null = await msalClient().acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: redirectUri(),
  });
  if (!result) return null;

  const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
  const email = (claims.email as string | undefined) ?? (claims.preferred_username as string | undefined);
  if (!email) return null;
  return email.toLowerCase().trim();
}
