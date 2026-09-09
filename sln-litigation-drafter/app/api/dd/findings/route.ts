import { NextRequest, NextResponse } from "next/server";
import { isValidSessionId, isBlobRevision } from "@/lib/blob";
import { isValidEntityId } from "@/lib/dd/blob-keys";
import { applyReviews, FindingsConflict, parseReviews, readFindings, writeFindings } from "@/lib/dd/findings-store";

export const maxDuration = 60;
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  const entityId = searchParams.get("entityId");
  if (!isValidSessionId(sessionId) || !isValidEntityId(entityId)) {
    return NextResponse.json({ error: "sessionId/entityId tidak valid" }, { status: 400 });
  }
  try { return reply(await readFindings(sessionId, entityId)); }
  catch { return reply({ error: "Temuan tersimpan tidak dapat dibaca. Coba muat ulang." }, 503); }
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return reply({ error: "payload tidak valid" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "payload tidak valid" }, 400);
  const b = body as Record<string, unknown>;
  if (!isValidSessionId(b.sessionId) || !isValidEntityId(b.entityId) ||
      Object.keys(b).some(k => !["sessionId", "entityId", "revision", "reviews"].includes(k))) return reply({ error: "payload tidak valid" }, 400);
  if (b.revision === undefined || b.revision === null) return reply({ error: "Muat ulang versi temuan sebelum menyimpan." }, 428);
  if (!isBlobRevision(b.revision)) return reply({ error: "versi temuan tidak valid" }, 400);
  let reviews;
  try { reviews = parseReviews(b.reviews); } catch { return reply({ error: "review tidak valid" }, 400); }
  try {
    const snapshot = await readFindings(b.sessionId, b.entityId);
    if (snapshot.revision !== b.revision) throw new FindingsConflict();
    let findings;
    try { findings = applyReviews(snapshot.findings, reviews); } catch { return reply({ error: "ID temuan tidak dikenal" }, 400); }
    const revision = await writeFindings(b.sessionId, b.entityId, findings, snapshot.revision);
    return reply({ findings, revision });
  } catch (e) {
    return e instanceof FindingsConflict ? reply({ error: e.message, code: "findings_conflict" }, 409)
      : reply({ error: "Penyimpanan review belum dapat dipastikan. Draft lokal dipertahankan." }, 503);
  }
}
