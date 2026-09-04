import { NextRequest, NextResponse } from "next/server";
import { saveApprovedDraft } from "@/lib/litigation-memory";
import { authorizeLitigation, litigationDenied, LitigationScopeError } from "@/lib/litigation-session";

export async function POST(req: NextRequest) {
  try {
    const { sessionId, draftText, docType, claimType, ref } = await req.json();
    const authority = await authorizeLitigation(sessionId);

    if (!draftText) {
      return NextResponse.json({ error: "Tidak ada teks draf" }, { status: 400 });
    }

    await saveApprovedDraft(authority, draftText, {
      docType: docType || "unknown",
      claimType: claimType || "",
      ref: ref || "",
    });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    if (e instanceof LitigationScopeError) return litigationDenied();
    const message = e instanceof Error ? e.message : "Gagal menyimpan ke memory";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
