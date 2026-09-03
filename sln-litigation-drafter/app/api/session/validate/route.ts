import { NextRequest } from "next/server";
import { authorizeLitigation, litigationDenied } from "@/lib/litigation-session";

export async function POST(req: NextRequest) {
  try {
    const { sessionId, folderPath } = await req.json();
    const r = await authorizeLitigation(sessionId, { root: folderPath });
    return Response.json({ sessionId: r.sessionId, folderPath: r.root });
  } catch { return litigationDenied(); }
}
