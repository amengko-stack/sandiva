import { NextRequest, NextResponse } from "next/server";
import { asc, eq, gte, lte, and } from "drizzle-orm";
import ExcelJS from "exceljs";
import { db, tables } from "@/db";
import { requireSession, todayJakarta } from "@/lib/api";
import { firmTotals, utilizationThisWeek } from "@/lib/reports/aggregate";

export const maxDuration = 60;

// Excel export: Matter performance + Utilization + Timesheet Activity
// (the report shape the firm knows from Prohukum). Partner/admin only.
export async function GET(req: NextRequest) {
  const auth = requireSession(["partner", "admin"]);
  if (!auth.ok) return auth.response;

  const today = todayJakarta();
  const from = req.nextUrl.searchParams.get("from") ?? today.slice(0, 8) + "01";
  const to = req.nextUrl.searchParams.get("to") ?? today;

  const [totals, utilization] = await Promise.all([firmTotals(), utilizationThisWeek()]);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Sandiva Timesheets";

  const perf = wb.addWorksheet("Matter performance");
  perf.columns = [
    { header: "Project", key: "code", width: 12 },
    { header: "Client", key: "client", width: 34 },
    { header: "Matter", key: "title", width: 40 },
    { header: "Fee type", key: "fee", width: 12 },
    { header: "Cur", key: "cur", width: 6 },
    { header: "Units", key: "units", width: 10 },
    { header: "Value delivered", key: "value", width: 16 },
    { header: "WIP", key: "wip", width: 16 },
    { header: "Billed", key: "billed", width: 16 },
    { header: "Agreed fee", key: "feeAmount", width: 16 },
    { header: "Margin %", key: "margin", width: 10 },
  ];
  totals.perf.forEach((m) =>
    perf.addRow({
      code: m.code, client: m.clientName, title: m.title, fee: m.feeType, cur: m.currency,
      units: m.actualUnits, value: m.valueDelivered, wip: m.wip, billed: m.billed,
      feeAmount: m.feeAmount ?? "", margin: m.marginPct ?? "",
    }),
  );
  perf.getRow(1).font = { bold: true };

  const util = wb.addWorksheet("Utilization");
  util.columns = [
    { header: "Initials", key: "ini", width: 10 },
    { header: "Fee earner", key: "name", width: 30 },
    { header: "Role", key: "role", width: 16 },
    { header: "Units this week", key: "units", width: 14 },
    { header: "Target", key: "target", width: 10 },
    { header: "%", key: "pct", width: 8 },
  ];
  utilization.forEach((u) => util.addRow({ ini: u.initials, name: u.name, role: u.role, units: u.weekUnits, target: u.target, pct: u.pct ?? "" }));
  util.getRow(1).font = { bold: true };

  const ts = wb.addWorksheet("Timesheet activity");
  ts.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Fee earner", key: "who", width: 26 },
    { header: "Client", key: "client", width: 30 },
    { header: "Project", key: "code", width: 12 },
    { header: "Matter", key: "title", width: 34 },
    { header: "Workcode", key: "wc", width: 14 },
    { header: "Description", key: "desc", width: 60 },
    { header: "Units", key: "units", width: 8 },
    { header: "Status", key: "status", width: 10 },
  ];
  const entries = await db()
    .select({
      date: tables.timeEntries.date,
      units: tables.timeEntries.units,
      workcode: tables.timeEntries.workcode,
      description: tables.timeEntries.description,
      status: tables.timeEntries.status,
      who: tables.users.name,
      code: tables.matters.matterCode,
      title: tables.matters.title,
      clientName: tables.clients.name,
    })
    .from(tables.timeEntries)
    .innerJoin(tables.users, eq(tables.timeEntries.userId, tables.users.id))
    .innerJoin(tables.matters, eq(tables.timeEntries.matterId, tables.matters.id))
    .innerJoin(tables.clients, eq(tables.matters.clientId, tables.clients.id))
    .where(and(gte(tables.timeEntries.date, from), lte(tables.timeEntries.date, to)))
    .orderBy(asc(tables.timeEntries.date));
  (entries as any[]).forEach((e) =>
    ts.addRow({ date: e.date, who: e.who, client: e.clientName, code: e.code, title: e.title, wc: e.workcode, desc: e.description, units: Number(e.units), status: e.status }),
  );
  ts.getRow(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(buf as ArrayBuffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sandiva-reports-${today}.xlsx"`,
    },
  });
}
