import { NextRequest, NextResponse } from "next/server";
import {
  mintSessionToken,
  timingSafeEqualStrings,
  SESSION_TTL_SECONDS,
} from "@/lib/auth";

// Best-effort per-instance rate limit: serverless instances don't share this
// map, but it still throttles sustained guessing against a warm instance.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  attempts.forEach((entry, key) => {
    if (entry.resetAt <= now) attempts.delete(key);
  });
  const entry = attempts.get(ip);
  if (!entry) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  try {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." },
        { status: 429 }
      );
    }

    const { password } = await req.json();

    const expectedPassword = process.env.APP_PASSWORD;
    if (!expectedPassword || !process.env.APP_SESSION_TOKEN) {
      return NextResponse.json(
        { error: "Server tidak dikonfigurasi dengan benar" },
        { status: 500 }
      );
    }

    if (typeof password !== "string" || !timingSafeEqualStrings(password, expectedPassword)) {
      return NextResponse.json(
        { error: "Kata sandi tidak valid" },
        { status: 401 }
      );
    }

    const sessionToken = mintSessionToken();
    if (!sessionToken) {
      return NextResponse.json(
        { error: "Server tidak dikonfigurasi dengan benar" },
        { status: 500 }
      );
    }

    attempts.delete(ip);

    const response = NextResponse.json({ ok: true });
    response.cookies.set("sln_session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Permintaan tidak valid" }, { status: 400 });
  }
}
