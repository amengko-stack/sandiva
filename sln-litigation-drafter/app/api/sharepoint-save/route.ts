import { NextRequest, NextResponse } from "next/server";
import { buildLitigationDocx } from "@/lib/docx-builder";
import { uploadFileToSharePoint } from "@/lib/graph-client";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { draftText, ref, docType, claimType, remotePath, filename } =
      await req.json();

    if (!draftText || !remotePath || !filename) {
      return NextResponse.json(
        { error: "Parameter tidak lengkap" },
        { status: 400 }
      );
    }

    const buffer = await buildLitigationDocx(draftText, {
      ref: ref || "SLN/DRF",
      docType: docType || "draf",
      claimType: claimType || "",
    });

    const webUrl = await uploadFileToSharePoint(remotePath, filename, buffer);

    return NextResponse.json({ ok: true, webUrl });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menyimpan ke SharePoint";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
