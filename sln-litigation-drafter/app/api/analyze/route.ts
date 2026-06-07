import { NextRequest, NextResponse } from "next/server";
import { analyzeCase } from "@/src/analyzer";
import { loadMemoryLibrary, buildMemoryContext } from "@/lib/blob";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { documentTexts, docTypeId, practiceAreaId, claimType } =
      await req.json();

    if (!documentTexts?.length) {
      return NextResponse.json(
        { error: "Tidak ada teks dokumen" },
        { status: 400 }
      );
    }

    const memory = await loadMemoryLibrary();
    const memoryContext = buildMemoryContext(memory);

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
