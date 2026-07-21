import { app, InvocationContext, Timer } from "@azure/functions";

// Timer Trigger (NCRONTAB: {second} {minute} {hour} {day} {month} {day-of-week}).
// "0 0 9 * * 5" = second 0, minute 0, hour 9, any day, any month, Friday (5)
// -> every Friday at 09:00:00 (Function App's timezone, UTC by default unless
// WEBSITE_TIME_ZONE app setting is set) — mirrors the old Vercel Cron
// schedule "0 9 * * 5" (Fridays 9am UTC).
//
// This function does no work of its own: it only calls the existing,
// already-authenticated sln-timesheet route, which contains all the actual
// reminder logic (checking logged hours, sending emails, etc).
export async function reminderCron(myTimer: Timer, context: InvocationContext): Promise<void> {
  const appUrl = process.env.APP_URL;
  const cronSecret = process.env.CRON_SECRET;

  if (!appUrl || !cronSecret) {
    context.error("reminderCron: missing APP_URL or CRON_SECRET application setting.");
    return;
  }

  const url = `${appUrl}/api/cron/reminders`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        // Must match exactly what sln-timesheet/src/app/api/cron/reminders/route.ts expects:
        // req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
        authorization: `Bearer ${cronSecret}`,
      },
    });

    const bodySnippet = (await res.text()).slice(0, 300);
    context.log(`reminderCron: ${res.status} ${res.statusText} - ${bodySnippet}`);
  } catch (err) {
    context.error(`reminderCron: request failed - ${err instanceof Error ? err.message : String(err)}`);
  }
}

app.timer("reminderCron", {
  schedule: "0 0 9 * * 5",
  handler: reminderCron,
});
