// Minimal in-memory login rate limiter (per key, sliding window). Good enough
// for a single-region Vercel deployment of a small firm; swap for a KV-backed
// limiter if the app ever scales out.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;

const attempts = new Map<string, number[]>();

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, recent);
  return recent.length >= MAX_ATTEMPTS;
}

export function recordAttempt(key: string): void {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
}

export function clearAttempts(key: string): void {
  attempts.delete(key);
}
