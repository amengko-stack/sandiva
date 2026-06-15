import { NextResponse } from "next/server";
import { loadJurisprudenceDb } from "@/lib/jurisprudence";

export async function GET() {
  try {
    const entries = await loadJurisprudenceDb();
    return NextResponse.json({ entries });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
