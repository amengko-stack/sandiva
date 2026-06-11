import { NextRequest, NextResponse } from "next/server";
import { buildLitigationDocx } from "@/lib/docx-builder";

export async function POST(req: NextRequest) {
  try {
    const { draftText, ref, docType, claimType } = await req.json();

    console.log(`[docx] received draftText=${draftText?.length ?? 0} chars ref=${ref} docType=${docType}`);
    if (!draftText) {
      return NextResponse.json({ error: "Tidak ada teks draf" }, { status: 400 });
    }

    const buffer = await buildLitigationDocx(draftText, {
      ref: ref || "SLN/DRF",
      docType: docType || "draf",
      claimType: claimType || "",
    });

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
