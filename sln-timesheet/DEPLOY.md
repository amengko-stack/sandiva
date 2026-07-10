# Deploying sln-timesheet to Vercel

The app is deploy-ready (build passes, E2E verified). Deployment needs your Vercel
login, so it's a one-time ~10-minute dashboard task.

## 1 · Create the database (Neon)

- In the Vercel dashboard → **Storage → Create Database → Neon (Postgres)** (or
  https://neon.tech directly, free tier is fine).
- Copy the **pooled connection string** (`postgres://...`).

## 2 · Create the Vercel project

- Vercel dashboard → **Add New → Project** → import the GitHub repo
  `amengko-stack/sandiva` (already connected — it powers the SLN drafter).
- **Root Directory: `sln-timesheet`** ← the important setting.
- Framework preset: Next.js (auto-detected). Branch to deploy: `main`
  (merge `feature/timesheet-m1` first, or point the project at that branch to try it).

## 3 · Environment variables (Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `DATABASE_URL` | the Neon pooled connection string |
| `APP_SESSION_TOKEN` | a long random secret (rotating it signs everyone out) |
| `CRON_SECRET` | another random secret (used by the weekly reminder cron) |
| `APP_BASE_URL` | the production URL, e.g. `https://sln-timesheet.vercel.app` |
| `RESEND_API_KEY` | optional now — enables reminder + password-reset email |
| `EMAIL_FROM` | e.g. `Sandiva Timesheets <timesheets@legal.sandiva.co>` |
| `ANTHROPIC_API_KEY` | optional now — enables the Ask-AI dashboard card |

Generate secrets locally with:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## 4 · Run migrations + seed the first admin (from this machine)

```bash
cd ~/dev/sandiva/sln-timesheet
DATABASE_URL="postgres://...neon..." npx drizzle-kit migrate
DATABASE_URL="postgres://...neon..." npx tsx scripts/seed.ts admin@sandiva.co "<strong-password>" "Operations Admin" OA
```

## 5 · Deploy & go-live sequence

1. Deploy (happens automatically on push once the project exists).
2. Sign in as the admin → **Users & rates**: create the 8 partners + associates
   with IDR/USD billing rates and cost rates (initials must match Prohukum's).
3. **Initial setup import**: upload `Clients-*.xls` → `Matter_Active-*.xls` →
   `Report Activity Timesheets.xlsx` (preview → confirm). Handling Partner
   becomes each matter's engagement partner — review under **Matters**.
4. **Settings**: confirm firm profile/bank block and the current PPN rate.
5. Announce cutover: from that day, all time is logged here — Prohukum retired.

## Notes

- The weekly reminder cron (Fri 09:00 UTC = 16:00 WIB) is configured in
  `vercel.json`; Vercel wires it automatically once `CRON_SECRET` is set.
- Local dev never needs any of this: `npm run dev:setup && npm run dev`
  (embedded PGlite DB, port 3100).
