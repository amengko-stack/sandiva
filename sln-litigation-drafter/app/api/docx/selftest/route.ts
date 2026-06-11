import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { buildLitigationDocx } from "@/lib/docx-builder";
import { writeMatterFile } from "@/lib/graph-client";

export const maxDuration = 60;

// TEMPORARY DEBUG ROUTE — builds a docx from CONSTANT text in the production
// runtime and uploads (1) the raw .docx and (2) a base64 .txt copy to the
// matter's AI/ folder, so the production artifact's exact bytes can be
// retrieved and compared against a local build. Remove after diagnosis.
const SAMPLE = `SURAT GUGATAN
Kepada Yth. Ketua Pengadilan Negeri Jakarta Pusat

I. IDENTITAS PARA PIHAK
1. Bahwa Penggugat adalah **PT Contoh Sejahtera**, berkedudukan di Jakarta;

PETITUM
1. Mengabulkan gugatan Penggugat untuk seluruhnya;`;

export async function GET(req: NextRequest) {
  try {
    const folderPath = req.nextUrl.searchParams.get("folder");
    if (!folderPath) {
      return NextResponse.json({ error: "param ?folder=<sharing link> wajib" }, { status: 400 });
    }

    const buf = await buildLitigationDocx(SAMPLE, {
      ref: "SLN/SELFTEST/2026",
      docType: "gugatan",
      claimType: "wanprestasi",
    });
    const sha = createHash("sha256").update(buf).digest("hex");
    const info = {
      size: buf.length,
      sha256: sha,
      node: process.version,
      firstBytes: buf.subarray(0, 4).toString("hex"),
    };
    console.log(`[docx-selftest] ${JSON.stringify(info)}`);

    await writeMatterFile(folderPath, "AI/docx_selftest.docx", buf,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await writeMatterFile(folderPath, "AI/docx_selftest_b64.txt", buf.toString("base64"), "text/plain");

    return NextResponse.json({ ok: true, ...info });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "selftest gagal";
    console.error("[docx-selftest] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
