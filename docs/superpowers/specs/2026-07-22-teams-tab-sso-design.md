# Sandiva Timesheets as a Teams personal app with zero-click SSO — design

**Date:** 2026-07-22 · **Status:** approved (brainstormed interactively with AHM)

## Problem

Staff live in Microsoft Teams; the timesheet app (Next.js 14 on Azure App Service, Entra ID sign-in)
should be one sidebar click away. Simply pinning the URL fails for two reasons:

1. `login.microsoftonline.com` refuses to render inside iframes, and Teams tabs are iframes — the
   current MSAL authorization-code redirect cannot run there.
2. The `slnts_session` cookie is `SameSite=Lax`; browsers withhold it in a Teams tab (third-party
   context), so even a signed-in user appears logged out inside Teams.

## Decisions (from brainstorming)

- **Zero-click silent SSO** — no login button inside Teams, ever.
- **Personal sidebar app** (`staticTabs`, scope `personal`) — each person gets their own role-scoped
  dashboard; works on Teams desktop, web, and mobile.
- **No bot / no Teams reminders** — the Friday reminder stays email-only (candidate phase 2).
- **No business-logic changes** — Teams is only a new front door.

## Design

Teams vouches for its signed-in user: the tab calls `authentication.getAuthToken()`
(`@microsoft/teams-js`), receiving an Entra-signed JWT whose audience is our own app registration.
A new endpoint `POST /api/auth/teams` verifies that JWT (signature via tenant JWKS, issuer, audience
`ENTRA_CLIENT_ID` or `api://<host>/<clientId>`, `tid` = tenant) and then behaves exactly like the
existing browser callback: case-insensitive lookup of an **active** user by email → mint the same
`slnts_session` HMAC cookie via `mintSessionToken`. No auto-provisioning; unknown users get the same
"no account — contact your admin" experience as the browser flow.

Auth doors after this change: (1) browser Entra redirect, (2) cron bearer token, (3) Teams token
exchange. All mint/validate the same session format; RBAC and every downstream check are untouched.

### Components

- **`/teams` bootstrap page** (public path): initializes teams-js, silently acquires the token, POSTs
  it, then replaces location with `/`. Branded "Signing you in…" screen; `no_account` and failure
  states with an "Open in browser" fallback link. Never renders a Microsoft redirect in the iframe.
- **`src/lib/auth/teams.ts`**: `verifyTeamsToken()` (jose `createRemoteJWKSet` + `jwtVerify`),
  unit-tested with a locally generated key pair standing in for the JWKS.
- **Cookie change**: `sessionCookieOptions()` helper — production `SameSite=None; Secure` (iframe
  compatible), dev stays `Lax` (http localhost). Used by Entra callback, Teams endpoint, logout.
- **CSRF compensation** (Lax→None removes implicit CSRF cover): middleware rejects mutating requests
  (POST/PATCH/PUT/DELETE) whose `Origin` header host mismatches the request host (403). Requests
  without `Origin` (cron/curl) pass; same-origin browser requests pass.
- **Framing policy**: `Content-Security-Policy: frame-ancestors` allowing only self + Teams/M365
  hosts (`teams.microsoft.com`, `*.teams.microsoft.com`, `*.skype.com`, `*.microsoft365.com`,
  `*.cloud.microsoft`).
- **Teams app package** (`teams-app/` at repo root): manifest (schema ≥1.17) with
  `webApplicationInfo { id: <clientId>, resource: api://<host>/<clientId> }`, personal static tab
  pointing at `https://<host>/teams`, `validDomains`, plus 192px color / 32px outline icons and a
  README covering zip + Teams admin center upload.

### Tenant configuration (admin actions, not code)

Entra app registration → *Expose an API*: Application ID URI `api://<host>/<clientId>`, scope
`access_as_user`, pre-authorized Teams/M365 client IDs (Teams desktop/mobile `1fec8e78-…`, Teams web
`5e3ce6c0-…`, M365 web `4765445b-…`, M365 desktop `0ec893e0-…`, Outlook desktop `d3590ed6-…`).
Then Teams admin center → Manage apps → upload the zip → allow for the org.

### Error handling

- Invalid/expired/foreign token → 401; tab shows failure + browser fallback link.
- Valid token, no matching active user → 403 `no_account`; tab shows the standard "no account" copy.
- `getAuthToken()` failure (e.g. consent misconfig) → failure state + browser fallback link.

### Testing

Unit tests for token verification (valid / wrong audience / wrong issuer / wrong tenant / expired);
existing 42-test suite and build stay green; curl checks for 400/401/403 paths and the CSRF guard;
manual live test in Teams desktop + mobile; regression test of normal browser login after the
cookie-flag change.

## Out of scope

Teams bot / chat notifications, channel tabs, message extensions, any timesheet business-logic change.
