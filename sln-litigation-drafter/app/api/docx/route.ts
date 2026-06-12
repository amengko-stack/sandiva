import { NextRequest, NextResponse } from "next/server";
import { buildLitigationDocx } from "@/lib/docx-builder";
import { verifyDocx } from "@/lib/docx-verify";

export async function POST(req: NextRequest) {
  try {
    const { draftText, ref, docType, claimType, citationAppendix } = await req.json();

    console.log(`[docx] received draftText=${draftText?.length ?? 0} chars ref=${ref} docType=${docType} appendix=${citationAppendix ? "yes" : "no"}`);
    if (!draftText) {
      return NextResponse.json({ error: "Tidak ada teks draf" }, { status: 400 });
    }

    const buffer = await buildLitigationDocx(
      draftText,
      { ref: ref || "SLN/DRF", docType: docType || "draf", claimType: claimType || "" },
      citationAppendix ?? undefined
    );

    // Verify integrity on the REAL draft before shipping; never serve a file
    // we can already prove is corrupt.
    const verdict = verifyDocx(buffer);
    console.log(`[docx] integrity size=${buffer.length} entriesBad=${verdict.bad} illegalChars=${verdict.illegal} draftChars=${draftText.length}`);
    if (verdict.bad > 0 || verdict.illegal > 0) {
      const detail = verdict.entries.filter((e) => !e.ok).map((e) => `${e.name}(crc:${e.dataCrc}/${e.centralCrc},illegal:${e.illegalChars})`).join(", ");
      console.error(`[docx] CORRUPT OUTPUT DETECTED: ${detail}`);
      return NextResponse.json(
        { error: `Dokumen yang dihasilkan terdeteksi korup (${detail}) — tidak dikirim. Laporkan pesan ini.` },
        { status: 500 }
      );
    }

    const filename = `${(ref || "draf").replace(/\//g, "-")}.docx`;

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": buffer.byteLength.toString(),
      },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal membuat dokumen";
    console.error("[docx] Error:", message, e instanceof Error ? e.stack : "");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
