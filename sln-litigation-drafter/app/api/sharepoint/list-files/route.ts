import { NextRequest, NextResponse } from "next/server";
import { listMatterFiles } from "@/lib/sharepoint";

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { folderPath } = await req.json();
    if (!folderPath?.trim()) {
      return NextResponse.json({ error: "folderPath wajib diisi" }, { status: 400 });
    }

    const files = await listMatterFiles(folderPath.trim());
    return NextResponse.json({ files });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Terjadi kesalahan";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
