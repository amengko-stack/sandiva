import { NextRequest, NextResponse } from "next/server";
import { readBlobText, writeBlobText, isValidSessionId } from "@/lib/blob";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";
import type { DDFinding } from "@/types/dd";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  const entityId = searchParams.get("entityId");
  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
    return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
  }
  const raw = await readBlobText(ddKeys.findings(sessionId, entityId));
  return NextResponse.json({ findings: raw ? (JSON.parse(raw) as DDFinding[]) : [] });
}

export async function PUT(req: NextRequest) {
  const { sessionId, entityId, findings } = (await req.json()) as {
    sessionId: string; entityId: string; findings: DDFinding[];
  };
  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId) || !Array.isArray(findings)) {
    return NextResponse.json({ error: "payload tidak valid" }, { status: 400 });
  }
  await writeBlobText(ddKeys.findings(sessionId, entityId), JSON.stringify(findings));
  return NextResponse.json({ ok: true });
}
