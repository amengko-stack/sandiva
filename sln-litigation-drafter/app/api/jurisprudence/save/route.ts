import { NextRequest, NextResponse } from "next/server";
import { loadJurisprudenceDb, saveJurisprudenceDb } from "@/lib/jurisprudence";
import { uploadFileToSharePoint } from "@/lib/graph-client";
import type { JurisprudenceEntry } from "@/types";

export async function POST(req: NextRequest) {
  try {
    const { entries, sourceFile } = (await req.json()) as {
      entries: JurisprudenceEntry[];
      sourceFile?: { name: string; base64: string; mime: string };
    };
    if (!Array.isArray(entries)) {
      return NextResponse.json({ error: "entries wajib berupa array" }, { status: 400 });
    }
    // These entries feed the citation checker's authoritative "terverifikasi"
    // override — reject malformed ones instead of stamping them verified.
    const wellFormed = entries.filter(
      (e) =>
        e &&
        typeof e.nomor === "string" && e.nomor.trim().length > 0 &&
        typeof e.kaidah === "string" &&
        Array.isArray(e.topik) && e.topik.every((t) => typeof t === "string")
    );
    if (wellFormed.length !== entries.length) {
      return NextResponse.json(
        { error: "Sebagian entri tidak lengkap (nomor/kaidah/topik) — periksa kembali sebelum menyimpan." },
        { status: 400 }
      );
    }
    const existing = await loadJurisprudenceDb();
    const existingNomor = new Set(existing.map((e) => e.nomor));
    const now = new Date().toISOString();
    const toAdd = wellFormed
      .filter((e) => !existingNomor.has(e.nomor))
      .map((e) => ({ ...e, verified: true, addedAt: now }));
    const merged = [...existing, ...toAdd];
    await saveJurisprudenceDb(merged);
    if (sourceFile) {
      const buf = Buffer.from(sourceFile.base64, "base64");
      await uploadFileToSharePoint("SLN-AI/jurisprudence/sources", sourceFile.name, buf, sourceFile.mime);
    }
    return NextResponse.json({ total: merged.length, entries: merged });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
