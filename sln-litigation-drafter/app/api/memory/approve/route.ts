import { NextRequest, NextResponse } from "next/server";
import { saveApprovedDraft } from "@/lib/blob";

export async function POST(req: NextRequest) {
  try {
    const { draftText, docType, claimType, ref } = await req.json();

    if (!draftText) {
      return NextResponse.json({ error: "Tidak ada teks draf" }, { status: 400 });
    }

    await saveApprovedDraft(draftText, {
      docType: docType || "unknown",
      claimType: claimType || "",
      ref: ref || "",
    });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Gagal menyimpan ke memory";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
