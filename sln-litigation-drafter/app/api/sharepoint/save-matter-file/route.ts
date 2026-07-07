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

    // The app's Graph credentials are tenant-wide; this route is the only one
    // that takes a client-supplied target path. Constrain writes to the AI/
    // and Drafts/ working folders and reject path tricks.
    const SAFE_TARGET_RE = /^(AI|Drafts)\/[A-Za-z0-9 ._()À-ɏ-]+$/;
    if (!SAFE_TARGET_RE.test(filename) || filename.includes("..")) {
      return NextResponse.json(
        { error: "filename harus berada di folder AI/ atau Drafts/ tanpa karakter khusus" },
        { status: 400 }
      );
    }

    const webUrl = await writeMatterFile(folderPath, filename, content, mimeType);
    return NextResponse.json({ ok: true, webUrl });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menyimpan ke SharePoint";
    console.error("[save-matter-file] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
