import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { jsonError, requireSession } from "@/lib/api";
import { db, tables } from "@/db";

// Wipes all imported Clients/Matters/historical time so setup can re-import
// cleanly. Blocked once real billing/logging exists — see guards below.
export async function POST(req: NextRequest) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  if (body?.confirm !== "RESET") return jsonError('Type "RESET" to confirm.');

  const invoices = await db().select({ id: tables.invoices.id }).from(tables.invoices);
  if (invoices.length > 0) {
    return jsonError(
      `Reset is disabled — ${invoices.length} invoice(s) have been issued. Billing has started.`,
      409,
    );
  }

  const nativeEntries = await db()
    .select({ id: tables.timeEntries.id })
    .from(tables.timeEntries)
    .where(eq(tables.timeEntries.isHistorical, false));
  if (nativeEntries.length > 0) {
    return jsonError(
      `${nativeEntries.length} time entr${nativeEntries.length === 1 ? "y was" : "ies were"} logged in the app — reset would delete real work. Delete those first or keep the data.`,
      409,
    );
  }

  const clients = await db().select({ id: tables.clients.id }).from(tables.clients);
  const matters = await db().select({ id: tables.matters.id }).from(tables.matters);
  const timeEntries = await db().select({ id: tables.timeEntries.id }).from(tables.timeEntries);
  const batches = await db().select({ id: tables.importBatches.id }).from(tables.importBatches);

  await db().delete(tables.matterTeam);
  await db().delete(tables.matterRates);
  await db().delete(tables.disbursements);
  await db().delete(tables.timeEntries);
  await db().delete(tables.matters);
  await db().delete(tables.clients);
  await db().delete(tables.importBatches);

  const deleted = {
    clients: clients.length,
    matters: matters.length,
    timeEntries: timeEntries.length,
    batches: batches.length,
  };

  await db().insert(tables.auditLog).values({
    actorId: auth.session.userId,
    action: "import_reset",
    entity: "import",
    entityId: "all",
    before: deleted,
  });

  return NextResponse.json({ ok: true, deleted });
}
