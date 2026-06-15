import { NextRequest, NextResponse } from "next/server";
import { loadJurisprudenceDb, saveJurisprudenceDb } from "@/lib/jurisprudence";
import { uploadFileToSharePoint } from "@/lib/graph-client";
import type { JurisprudenceEntry } from "@/types";

export async function POST(req: NextRequest) {
  try {
    const { entries, sourceFile } = await req.json() as {
      entries: JurisprudenceEntry[];
      sourceFile?: { name: string; base64: string; mime: string };
    };
    const existing = await loadJurisprudenceDb();
    const existingNomor = new Set(existing.map((e) => e.nomor));
    const now = new Date().toISOString();
    const toAdd = entries
      .filter((e) => !existingNomor.has(e.nomor))
      .map((e) => ({ ...e, verified: true, addedAt: now }));
    const merged = [...existing, ...toAdd];
    await saveJurisprudenceDb(merged);
    if (sourceFile) {
      const buf = Buffer.from(sourceFile.base64, "base64");
      await uploadFileToSharePoint("SLN-AI/jurisprudence/sources", sourceFile.name, buf, sourceFile.mime);
    }
    return NextResponse.json({ total: merged.length });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
