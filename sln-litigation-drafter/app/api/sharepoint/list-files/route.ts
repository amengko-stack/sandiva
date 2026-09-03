import { NextRequest } from "next/server";
import { listMatterFiles } from "@/lib/litigation-sharepoint";
import { authorizeLitigation, recordLitigationListing, litigationDenied, LitigationScopeError } from "@/lib/litigation-session";

export const maxDuration = 120;
export async function POST(req: NextRequest) {
  try {
    const { sessionId, folderPath } = await req.json();
    const registration = await authorizeLitigation(sessionId, { root: folderPath });
    const files = await listMatterFiles(registration);
    await recordLitigationListing(registration, files);
    return Response.json({ files });
  } catch (e) {
    if (e instanceof LitigationScopeError) return litigationDenied();
    return Response.json({ error: "Gagal memuat daftar dokumen matter." }, { status: 500 });
  }
}
