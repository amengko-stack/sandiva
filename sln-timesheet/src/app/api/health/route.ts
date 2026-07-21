import { NextResponse } from "next/server";

// Lightweight liveness ping for Azure App Service. Not gated by auth — see
// PUBLIC_PATHS in middleware.ts — since the platform's health-check probe
// carries no session cookie.
export async function GET() {
  return NextResponse.json({ ok: true }, { status: 200 });
}
