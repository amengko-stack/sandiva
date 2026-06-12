import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { buildLitigationDocx } from "@/lib/docx-builder";

export const maxDuration = 60;

// TEMPORARY DEBUG ROUTE — builds a docx from CONSTANT text in the production
// runtime and returns size/sha256/base64 directly in the JSON response so the
// exact production bytes can be compared against a local build of identical
// code. No parameters, no uploads. Remove after diagnosis.
const SAMPLE = `SURAT GUGATAN
Kepada Yth. Ketua Pengadilan Negeri Jakarta Pusat

I. IDENTITAS PARA PIHAK
1. Bahwa Penggugat adalah **PT Contoh Sejahtera**, berkedudukan di Jakarta;

PETITUM
1. Mengabulkan gugatan Penggugat untuk seluruhnya;`;

export async function GET() {
  try {
    const buf = await buildLitigationDocx(SAMPLE, {
      ref: "SLN/SELFTEST/2026",
      docType: "gugatan",
      claimType: "wanprestasi",
    });
    const info = {
      size: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      node: process.version,
      firstBytes: buf.subarray(0, 4).toString("hex"),
      b64: buf.toString("base64"),
    };
    console.log(`[docx-selftest] size=${info.size} sha256=${info.sha256} node=${info.node}`);
    return NextResponse.json(info);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "selftest gagal";
    console.error("[docx-selftest] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
