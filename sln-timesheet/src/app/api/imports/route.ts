import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { jsonError, requireSession } from "@/lib/api";
import { parseClients, parseMatters, parseTimesheetRows } from "@/lib/import/prohukum";
import { applyClients, applyMatters, applyTime } from "@/lib/import/apply";
import { db, tables } from "@/db";

export const maxDuration = 60;

async function xlsxToMatrix(buf: ArrayBuffer): Promise<(string | number | null)[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  const matrix: (string | number | null)[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as any[]).slice(1);
    matrix.push(
      vals.map((v) =>
        v === undefined || v === null
          ? null
          : typeof v === "object" && v?.richText
            ? v.richText.map((t: any) => t.text).join("")
            : v instanceof Date
              ? v.getTime() / 86400000 + 25569
              : (v as any),
      ),
    );
  });
  return matrix;
}

// mode=preview (dry run) | mode=commit — same parsing path for both, so what
// you previewed is exactly what gets written.
export async function POST(req: NextRequest) {
  const auth = requireSession(["admin"]);
  if (!auth.ok) return auth.response;

  const form = await req.formData().catch(() => null);
  if (!form) return jsonError("Upload the Prohukum export files as multipart form data.");
  const mode = form.get("mode") === "commit" ? "commit" : "preview";
  const dryRun = mode === "preview";

  const out: Record<string, unknown> = { mode };

  const clientsFile = form.get("clients") as File | null;
  if (clientsFile && clientsFile.size > 0) {
    const parsed = parseClients(await clientsFile.text());
    const summary = await applyClients(parsed.rows, dryRun);
    out.clients = { filename: clientsFile.name, parsed: parsed.rows.length, parseErrors: parsed.errors, ...summary };
    if (!dryRun)
      await db().insert(tables.importBatches).values({
        filename: clientsFile.name, kind: "clients", importedBy: auth.session.userId,
        summary: { parsed: parsed.rows.length, ...summary, parseErrors: parsed.errors.length },
      });
  }

  const mattersFile = form.get("matters") as File | null;
  if (mattersFile && mattersFile.size > 0) {
    const parsed = parseMatters(await mattersFile.text());
    const summary = await applyMatters(parsed.rows, dryRun);
    out.matters = { filename: mattersFile.name, parsed: parsed.rows.length, parseErrors: parsed.errors, ...summary };
    if (!dryRun)
      await db().insert(tables.importBatches).values({
        filename: mattersFile.name, kind: "matters", importedBy: auth.session.userId,
        summary: { parsed: parsed.rows.length, ...summary, parseErrors: parsed.errors.length },
      });
  }

  const timeFile = form.get("time") as File | null;
  if (timeFile && timeFile.size > 0) {
    const parsed = parseTimesheetRows(await xlsxToMatrix(await timeFile.arrayBuffer()));
    const summary = await applyTime(parsed.rows, dryRun);
    out.time = { filename: timeFile.name, parsed: parsed.rows.length, parseErrors: parsed.errors, ...summary };
    if (!dryRun)
      await db().insert(tables.importBatches).values({
        filename: timeFile.name, kind: "time", importedBy: auth.session.userId,
        summary: { parsed: parsed.rows.length, ...summary, parseErrors: parsed.errors.length },
      });
  }

  if (!out.clients && !out.matters && !out.time) return jsonError("Attach at least one export file.");
  return NextResponse.json(out);
}
