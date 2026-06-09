import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();

    console.log('ENV CHECK:', {
      hasPassword: !!process.env.APP_PASSWORD,
      passwordLength: process.env.APP_PASSWORD?.length ?? 0,
      hasToken: !!process.env.APP_SESSION_TOKEN,
      tokenLength: process.env.APP_SESSION_TOKEN?.length ?? 0,
    });

    const expectedPassword = process.env.APP_PASSWORD;
    const sessionToken = process.env.APP_SESSION_TOKEN;

    if (!expectedPassword || !sessionToken) {
      return NextResponse.json(
        { error: "Server tidak dikonfigurasi dengan benar" },
        { status: 500 }
      );
    }

    if (password !== expectedPassword) {
      return NextResponse.json(
        { error: "Kata sandi tidak valid" },
        { status: 401 }
      );
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set("sln_session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7,
      path: "/",
    });
    return response;
  } catch {
    return NextResponse.json({ error: "Permintaan tidak valid" }, { status: 400 });
  }
}
