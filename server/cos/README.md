# Chief of Staff module — connector setup

Without any credentials the app runs on realistic demo providers, so everything
works out of the box. To connect real accounts, set env vars (e.g. in `.env`)
and restart — `getEmailProvider()` / `getTeamsProvider()` in `providers.ts`
pick the real connector automatically.

## Office 365 / Outlook email + MS Teams (Microsoft Graph)

Both use one Azure app registration with **client-credentials** auth:

1. Azure Portal → App registrations → New registration.
2. API permissions → Microsoft Graph → **Application permissions**:
   - `Mail.Read` (Outlook inbox)
   - `Chat.Read.All` (Teams chats)
   Then **Grant admin consent** for the tenant.
3. Certificates & secrets → New client secret.

```
AZURE_TENANT_ID=<directory (tenant) id>
AZURE_CLIENT_ID=<application (client) id>
AZURE_CLIENT_SECRET=<client secret value>
COS_MAILBOX=a.mengko@yourfirm.com     # mailbox to triage (UPN)
COS_FIRM_DOMAIN=yourfirm.com          # optional: senders from this domain triage as internal
TEAMS_CHAT_IDS=<chat-id-1>,<chat-id-2> # Graph chat ids to poll
```

Email activates when the three `AZURE_*` vars **and** `COS_MAILBOX` are set;
Teams activates with just the three `AZURE_*` vars.

Tip: consider restricting the app's mailbox access with an
[application access policy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
so `Mail.Read` only reaches `COS_MAILBOX`.

## Gmail (alternative email source)

```
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...   # OAuth refresh token with gmail.readonly scope
```

Outlook takes priority if both are configured.

## AI triage / analysis / reply drafting

```
ANTHROPIC_API_KEY=...     # optional — deterministic heuristics used when absent
COS_PARTNER_NAME=A. Mengko # signature on drafted replies
```
