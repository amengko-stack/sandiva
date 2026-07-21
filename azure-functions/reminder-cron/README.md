# reminder-cron

Standalone Azure Function (Node.js, `@azure/functions` v4 programming model, Timer Trigger) that
replaces the Vercel Cron job previously defined in `sln-timesheet/vercel.json`
(`GET /api/cron/reminders`, Fridays 9am UTC), now that sln-timesheet is moving off Vercel to Azure
App Service. It does no reminder logic itself — it just makes one authenticated HTTPS call to the
existing route on a schedule; all the actual work (checking logged hours, sending emails) still
lives in `sln-timesheet`.

The Function App must have two Application Settings configured:
- `APP_URL` — base URL of the deployed sln-timesheet App Service (e.g.
  `https://sln-timesheet.azurewebsites.net`), no trailing slash.
- `CRON_SECRET` — must match the `CRON_SECRET` value configured on the sln-timesheet App Service
  exactly, since the route validates requests via `Authorization: Bearer <CRON_SECRET>`.

This is a fully separate project from `sln-timesheet` (own `package.json`, `tsconfig.json`,
dependencies) and is meant to be built and deployed via CI/CD or, for manual/one-off deploys:

```
func azure functionapp publish <function-app-name>
```

(placeholder command — swap in the real Function App name once that resource is provisioned).
