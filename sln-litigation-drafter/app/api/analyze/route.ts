import { NextRequest, NextResponse } from "next/server";
import { analyzeCase } from "@/src/analyzer";
import { loadMemoryLibrary, buildMemoryContext, readBlobText } from "@/lib/blob";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, docTypeId, practiceAreaId, claimType } = await req.json();

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId wajib diisi" }, { status: 400 });
    }

    const combinedText = await readBlobText(`sessions/${sessionId}/documents.txt`);
    if (!combinedText || combinedText.length < 50) {
      return NextResponse.json(
        { error: "Dokumen belum diproses atau sesi tidak ditemukan. Kembali ke tahap sebelumnya." },
        { status: 400 }
      );
    }

    const memory = await loadMemoryLibrary();
    const memoryContext = buildMemoryContext(memory);

    // analyzeCase expects { name, content }[] — wrap the combined blob text as one entry
    const documentTexts = [{ name: "Dokumen Perkara", content: combinedText }];

    const analysis = await analyzeCase(
      documentTexts,
      docTypeId,
      claimType,
      memoryContext
    );

    return NextResponse.json({ analysis });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
