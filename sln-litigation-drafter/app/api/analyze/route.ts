import { NextRequest, NextResponse } from "next/server";
import { analyzeCase } from "@/src/analyzer";
import { loadMemoryLibrary, buildMemoryContext, readBlobText, isValidSessionId } from "@/lib/blob";
import type { ReviewTableRow } from "@/types";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { sessionId, docTypeId, practiceAreaId, claimType } = await req.json();

    if (!isValidSessionId(sessionId)) {
      return NextResponse.json({ error: "sessionId tidak valid" }, { status: 400 });
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

    // If a review table exists (regeneration / Tambah Dokumen re-analysis),
    // give the analyzer a compact per-document index so the analysis can cite
    // specific documents instead of one merged blob.
    let reviewDigest = "";
    try {
      const rtRaw = await readBlobText(`sessions/${sessionId}/review_table.json`);
      if (rtRaw) {
        const rt = JSON.parse(rtRaw) as { rows?: ReviewTableRow[] };
        const lines = (rt.rows ?? [])
          .filter((r) => r.status === "selesai")
          .map((r) =>
            `- ${r.fileName} [${r.category}; ${r.jenisDokumen}; ${r.tanggal}${r.nilai !== "—" ? `; ${r.nilai}` : ""}]: ${r.poinKunci}`
          );
        if (lines.length > 0) {
          reviewDigest =
            `\n\n=== INDEKS DOKUMEN (TABEL TINJAUAN) ===\n` +
            `Rujuk dokumen secara spesifik dengan nama file dari indeks ini:\n` +
            lines.join("\n").slice(0, 8000) + "\n";
        }
      }
    } catch {
      // Digest is optional context — analysis proceeds without it.
    }

    // analyzeCase expects { name, content }[] — wrap the combined blob text as one entry
    const documentTexts = [{ name: "Dokumen Perkara", content: combinedText }];

    const t0 = Date.now();
    const analysis = await analyzeCase(
      documentTexts,
      docTypeId,
      claimType,
      memoryContext + reviewDigest
    );
    // If this line never appears in the function logs, the function was killed
    // (timeout/crash) mid-call — that's the platform plain-text error the client sees.
    console.log(`[analyze] analyzeCase completed in ${Date.now() - t0}ms`);

    return NextResponse.json({ analysis });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
