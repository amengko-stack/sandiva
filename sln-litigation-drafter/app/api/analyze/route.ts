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

    const blobKey = `sessions/${sessionId}/extracted_text.json`;
    console.log(`[analyze] READ blob: sessionId=${sessionId} key=${blobKey}`);
    const combinedText = await readBlobText(blobKey);
    console.log(`[analyze] READ result: sessionId=${sessionId} found=${combinedText !== null} chars=${combinedText?.length ?? 0}`);
    if (!combinedText || combinedText.length < 50) {
      return NextResponse.json(
        { error: "Belum ada dokumen dengan teks yang dapat dianalisis — selesaikan ekstraksi atau OCR terlebih dahulu." },
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
