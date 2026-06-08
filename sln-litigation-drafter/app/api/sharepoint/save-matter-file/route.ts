import { NextRequest, NextResponse } from "next/server";
import { writeMatterFile } from "@/lib/graph-client";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { folderPath, filename, content, mimeType } = (await req.json()) as {
      folderPath: string;
      filename: string;
      content: string;
      mimeType?: string;
    };

    if (!folderPath || !filename || content === undefined) {
      return NextResponse.json({ error: "folderPath, filename, dan content wajib diisi" }, { status: 400 });
    }

    const webUrl = await writeMatterFile(folderPath, filename, content, mimeType);
    return NextResponse.json({ ok: true, webUrl });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menyimpan ke SharePoint";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
