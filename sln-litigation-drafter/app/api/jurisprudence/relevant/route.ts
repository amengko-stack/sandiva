import { NextRequest, NextResponse } from "next/server";
import { loadJurisprudenceDb, searchRelevant } from "@/lib/jurisprudence";

export async function POST(req: NextRequest) {
  try {
    const { docTypeId, claimType, kronologi } = (await req.json()) as {
      docTypeId?: string;
      claimType?: string | null;
      kronologi?: string;
    };
    const entries = await loadJurisprudenceDb();
    if (entries.length === 0) return NextResponse.json({ entries: [] });
    const relevant = searchRelevant(entries, docTypeId ?? "", claimType, kronologi ?? "");
    return NextResponse.json({ entries: relevant });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
