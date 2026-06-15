import { NextRequest, NextResponse } from "next/server";
import { loadJurisprudenceDb, saveJurisprudenceDb } from "@/lib/jurisprudence";

export async function POST(req: NextRequest) {
  try {
    const { id } = await req.json() as { id: string };
    const entries = await loadJurisprudenceDb();
    const filtered = entries.filter((e) => e.id !== id);
    await saveJurisprudenceDb(filtered);
    return NextResponse.json({ total: filtered.length });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
