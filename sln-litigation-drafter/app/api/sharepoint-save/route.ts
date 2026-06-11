import { NextRequest, NextResponse } from "next/server";
import { buildLitigationDocx } from "@/lib/docx-builder";
import { writeMatterFile } from "@/lib/graph-client";

export const maxDuration = 60;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function POST(req: NextRequest) {
  try {
    const { draftText, ref, docType, claimType, folderPath, filename } =
      await req.json();

    if (!draftText || !folderPath || !filename) {
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

    // filename includes the "Drafts/" subfolder; writeMatterFile resolves the
    // matter's drive from the sharing link and auto-creates Drafts/ if missing.
    const webUrl = await writeMatterFile(folderPath, filename, buffer, DOCX_MIME);

    return NextResponse.json({ ok: true, webUrl });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menyimpan ke SharePoint";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
