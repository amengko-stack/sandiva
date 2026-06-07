import { NextRequest, NextResponse } from "next/server";
import { readMultipleFiles } from "@/lib/sharepoint";
import type { FileEntry } from "@/types";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { files } = (await req.json()) as { files: FileEntry[] };
    if (!files?.length) {
      return NextResponse.json({ error: "Tidak ada file yang dipilih" }, { status: 400 });
    }

    const documentTexts = await readMultipleFiles(files);
    return NextResponse.json({ documentTexts });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
