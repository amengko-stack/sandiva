import { NextResponse } from "next/server";
import { ddHealth } from "@/lib/dd/health";

export const maxDuration = 10;
// Configuration is read at request time, so this must never be prerendered.
export const dynamic = "force-dynamic";

/**
 * Is this deployment configured for due diligence?
 *
 * Presence of each setting, never its value. Behind the app's auth like every other
 * route here.
 *
 * It exists because the failure that matters is silent: without a Perplexity key the
 * regulation-currency check returns "unknown" for every reference rather than
 * failing, so a report goes out with an empty currency column and nothing anywhere
 * says why.
 */
export function GET() {
  const health = ddHealth();
  return NextResponse.json(health, {
    // A stale answer about configuration is worse than no answer.
    headers: { "Cache-Control": "no-store" },
  });
}
