import { todayJakarta } from "@/lib/api";

/** Monday-start week (ISO dates) containing `date` (default: today, Jakarta). */
export function weekOf(date?: string): { days: string[]; start: string; end: string } {
  const d = date ?? todayJakarta();
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  const dow = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  dt.setUTCDate(dt.getUTCDate() - dow);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(dt.getTime() + i * 86400000).toISOString().slice(0, 10));
  }
  return { days, start: days[0], end: days[6] };
}

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
