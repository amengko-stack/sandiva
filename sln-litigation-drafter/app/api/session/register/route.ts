import { NextRequest } from "next/server";
import { createLitigationSession, litigationDenied } from "@/lib/litigation-session";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || Object.prototype.hasOwnProperty.call(body, "sessionId")) return litigationDenied();
    const registration = await createLitigationSession(body.folderPath);
    return Response.json({ sessionId: registration.sessionId, folderPath: registration.root });
  } catch { return litigationDenied(); }
}
