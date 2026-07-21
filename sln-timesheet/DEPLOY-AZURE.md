# Migrating sln-timesheet to Azure + Entra ID

The code is built, reviewed, and committed (`feature/timesheet-m1`, commit `8eb3b6a`):
Entra ID SSO replaces email/password login, the DB driver is standard Postgres/TCP
(`pg` + node-postgres) instead of Neon's HTTP driver, `next.config.mjs` has
`output: "standalone"` for App Service, and a GitHub Actions workflow + Azure Function
(Timer Trigger) replace `vercel --prod` and Vercel Cron.

Everything below needs your Azure/Entra portal access — none of it can be done headless.
**Vercel stays live and untouched** until step 8 confirms Azure works end-to-end.

## 1 · Register the app in Microsoft Entra admin center

- entra.microsoft.com → **Applications → App registrations → New registration**
- Name: `Sandiva Timesheets`, single tenant ("Accounts in this organizational directory only")
- Redirect URI: platform **Web**, `https://<your-app-host>/api/auth/entra/callback`
  (use a placeholder host for now if the App Service name isn't decided yet — you can add/edit
  redirect URIs later, just don't skip this field type)
- After creation, copy from the **Overview** page: **Application (client) ID** and **Directory
  (tenant) ID**
- **Certificates & secrets → New client secret** → copy the **value** immediately (shown once)

→ gives you `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`

## 2 · Provision Azure Database for PostgreSQL Flexible Server

- Azure Portal → **Create a resource → Azure Database for PostgreSQL flexible server**
- Compute: **Burstable, B1ms** (matches current usage)
- Region: pick whatever's closest to Jakarta that your subscription offers (e.g. an
  Asia-Pacific region) — same region as the App Service in step 3
- Set an admin username/password, note them
- **Networking**: allow the App Service to reach it (either "Allow public access from Azure
  services" or a VNet — public-with-firewall is simplest to start)
- Once created, the connection string is:
  `postgres://<admin>:<password>@<server-name>.postgres.database.azure.com:5432/postgres?sslmode=require`

## 3 · Provision the App Service

- Azure Portal → **Create a resource → Web App**
- Publish: **Code**, Runtime stack: **Node 20 LTS**, OS: **Linux**
- Plan: **Basic B1** to start
- Same region as the Postgres server from step 2
- Once created, go back to Entra (step 1) and fix the redirect URI to the real hostname:
  `https://<actual-app-name>.azurewebsites.net/api/auth/entra/callback`

## 4 · Set Application Settings (App Service → Configuration → Application settings)

| Name | Value |
|---|---|
| `DATABASE_URL` | the connection string from step 2 |
| `APP_SESSION_TOKEN` | new random secret — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CRON_SECRET` | another new random secret (must match the Azure Function's setting in step 6) |
| `APP_BASE_URL` | `https://<actual-app-name>.azurewebsites.net` |
| `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` | from step 1 |
| `RESEND_API_KEY`, `EMAIL_FROM` | carry over from the current Vercel project |
| `ANTHROPIC_API_KEY` | carry over from the current Vercel project |

Use **new** `APP_SESSION_TOKEN`/`CRON_SECRET` values — don't reuse the Vercel ones, since both
environments would otherwise accept each other's cookies/cron calls while both are live.

## 5 · Migrate the data (Neon → Azure Postgres)

Run from your machine, using the Neon connection string you already have and the new Azure one
from step 2:

```bash
pg_dump "postgres://...neon.../db" -Fc -f sln-timesheet.dump
pg_restore -d "postgres://...azure.../postgres" --no-owner --no-privileges sln-timesheet.dump
```

Then confirm schema + row counts:

```bash
cd sln-timesheet
DATABASE_URL="postgres://...azure.../postgres" npx drizzle-kit migrate
```

Spot-check row counts per table (`clients`, `matters`, `users`, `time_entries`, `invoices`,
`invoice_lines`, `audit_log`) between Neon and Azure before trusting the copy.

## 6 · Deploy the reminder Azure Function

- Azure Portal → **Create a resource → Function App** → Runtime: Node 20, plan: **Consumption**
- Once created, **Configuration → Application settings**, add:
  - `APP_URL` = same as `APP_BASE_URL` above, no trailing slash
  - `CRON_SECRET` = **exactly** the same value you set in step 4
- Deploy the code from `azure-functions/reminder-cron/`:
  ```bash
  cd azure-functions/reminder-cron
  npm install && npm run build
  func azure functionapp publish <function-app-name>
  ```
  (needs [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) installed once)

## 7 · Set up CI/CD (GitHub Actions)

- App Service → **Get publish profile** (download the file) → GitHub repo → **Settings → Secrets
  and variables → Actions** → add secrets: `AZURE_WEBAPP_PUBLISH_PROFILE` (paste the file
  contents) and `AZURE_WEBAPP_NAME` (the App Service name)
- The workflow (`.github/workflows/deploy-azure.yml`) triggers on push to `feature/timesheet-m1`
  for now — push to trigger the first deploy, or run it manually from the Actions tab

## 8 · Verify before cutover

- Visit `https://<app-name>.azurewebsites.net/login` → **Sign in with Microsoft** → confirm the
  full round trip: redirect to Microsoft → consent → callback → session cookie → dashboard
- Try an email that has **no** matching user row → confirm the "no account" page, not a crash
- Log time → submit → approve → issue an invoice → download the PDF → check a report export —
  the full business flow, not just login
- Confirm the Function fires (or trigger it manually from the portal) and the reminder email sends

## 9 · Cutover

Only after step 8 is fully green:

- Point your real domain / tell staff the new URL
- Leave the Vercel deployment **paused, not deleted**, for a rollback window
- Once confident, decommission Vercel + Neon (and rotate/remove any leftover Neon credentials —
  `.env.prod` on this machine has live Neon/Vercel credentials in plaintext; rotate those
  regardless of whether you keep or drop Neon)
