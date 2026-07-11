// Reminder due/overdue logic and the background sweep that escalates
// open reminders past their due time.
import * as storage from "../storage";
import type { CosReminder } from "@shared/schema";

export type ReminderBucket = "overdue" | "today" | "upcoming" | "done";

export function bucketReminder(r: Pick<CosReminder, "status" | "due_at">, now: Date = new Date()): ReminderBucket {
  if (r.status === "done") return "done";
  const due = new Date(r.due_at);
  if (due.getTime() < now.getTime()) return "overdue";
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  if (due.getTime() <= endOfToday.getTime()) return "today";
  return "upcoming";
}

/** Mark open reminders whose due time has passed as overdue. Returns ids escalated. */
export function sweepOverdue(now: Date = new Date()): number[] {
  const open = storage.cosGetReminders("open");
  const overdueIds = open
    .filter(r => new Date(r.due_at).getTime() < now.getTime())
    .map(r => r.id);
  storage.cosMarkRemindersOverdue(overdueIds);
  return overdueIds;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startReminderSweep(intervalMs = 60000): void {
  if (sweepTimer) return;
  sweepOverdue();
  sweepTimer = setInterval(() => {
    try {
      sweepOverdue();
    } catch (err) {
      console.error("Reminder sweep failed:", err);
    }
  }, intervalMs);
  sweepTimer.unref?.();
}

export function stopReminderSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
