# teams-app

Microsoft Teams personal-app packaging for the SLN Timesheet web app
(`sandiva-timesheet-g5hqesava4bme7ha.southeastasia-01.azurewebsites.net`), with SSO via Entra ID
(client ID `d54712ab-3bc5-40a7-9072-595bff65f370`).

Contents:
- `manifest.json` — Teams app manifest (schema v1.17), configures a single personal static tab
  pointing at `/teams` on the app host, plus `webApplicationInfo` for Teams SSO.
- `color.png` — 192x192 color icon (navy background, gold mark).
- `outline.png` — 32x32 outline icon (white mark on transparent background, per Teams requirements).

## Prerequisite: Entra "Expose an API" configuration

Before uploading this app to Teams, the Entra ID app registration for client ID
`d54712ab-3bc5-40a7-9072-595bff65f370` must have its "Expose an API" blade configured
(Application ID URI set to `api://sandiva-timesheet-g5hqesava4bme7ha.southeastasia-01.azurewebsites.net/d54712ab-3bc5-40a7-9072-595bff65f370`,
a scope such as `access_as_user` added, and the Teams desktop/mobile/web client IDs
pre-authorized). See the project's deployment runbook (`DEPLOY-AZURE.md`-style doc) and the
design spec at `docs/superpowers/specs/2026-07-22-teams-tab-sso-design.md` for the full steps.
Without this, SSO token exchange in the Teams tab will fail even if the manifest uploads fine.

## Building the upload package

Teams requires a zip with `manifest.json`, `color.png`, and `outline.png` at the zip **root**
(no subfolder). From this directory:

```powershell
Compress-Archive -Path manifest.json,color.png,outline.png -DestinationPath sandiva-timesheets-teams.zip -Force
```

Or on macOS/Linux:

```bash
zip -j sandiva-timesheets-teams.zip manifest.json color.png outline.png
```

## Uploading to Teams

Teams admin center → **Teams apps** → **Manage apps** → **Upload new app**, then select the zip.
(Alternatively, for personal/dev testing, use Teams client → Apps → **Manage your apps** →
**Upload an app** → **Upload a custom app**.)
