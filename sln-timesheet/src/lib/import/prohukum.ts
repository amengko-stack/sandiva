// Prohukum export parsers — ONE-TIME initial-setup import (after cutover this
// app is the system of record; there is no ongoing sync).
//
// Real-file quirks these handle (verified against the firm's actual exports):
// - Clients/Matters: HTML <table> saved with a .xls extension + UTF-8 BOM,
//   mojibake ("Göbel" -> "GÃ¶bel"/"G�bel"), ragged rows (trailing cells
//   omitted), multi-line cells with <br> and commas, leading "'" on codes.
// - Timesheets: a real .xlsx; metadata in rows 1-10, header on row 11, a
//   trailing "Total" row; Timesheet Date is an Excel SERIAL; Unit = hours
//   (2dp); Rate/Amount preserved as imported (never re-resolved).
// Rows that cannot be confidently parsed land in `errors` — never dropped
// silently. Preview + confirm happens in the UI before anything is written.

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Repair the common UTF-8-read-as-Latin-1 mojibake (Ã¶ -> ö etc.). */
export function fixMojibake(s: string): string {
  if (!/[ÃÂ][-¿]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from([...s].map((ch) => ch.charCodeAt(0) & 0xff));
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return repaired;
  } catch {
    return s;
  }
}

function cleanCell(raw: string): string {
  const noTags = raw.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "");
  return fixMojibake(decodeEntities(noTags)).replace(/\s+/g, " ").trim();
}

/** Parse an HTML <table> document into rows of cell strings. */
export function parseHtmlTable(content: string): string[][] {
  const rows: string[][] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(content))) {
    const cells: string[] = [];
    let cell: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cell = cellRe.exec(tr[1]))) cells.push(cleanCell(cell[1]));
    if (cells.some((c) => c !== "")) rows.push(cells);
  }
  return rows;
}

export function stripCode(s: string): string {
  return s.replace(/^'+/, "").trim();
}

const EMPTYISH = new Set(["", "-", "---"]);
const blank = (s: string | undefined) => s === undefined || EMPTYISH.has(s.trim());
const val = (s: string | undefined) => (blank(s) ? null : s!.trim());

/** "75,000,000.00" -> 75000000 (minor units, IDR-style). Null if not money. */
export function parseMoney(s: string | undefined): number | null {
  if (!s || !/^[\d,]+\.\d{2}$/.test(s.trim())) return null;
  return Math.round(Number(s.replace(/,/g, "")));
}

/** Excel 1900-system serial -> ISO date. */
export function excelSerialToISO(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

export interface ImportError {
  row: number;
  reason: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Clients.xls
// ---------------------------------------------------------------------------

export interface ClientRow {
  clientCode: string;
  name: string;
  npwp: string | null;
  billingAddress: string | null;
  contactPerson: string | null;
  email: string | null;
}

export function parseClients(content: string): { rows: ClientRow[]; errors: ImportError[] } {
  const table = parseHtmlTable(content);
  const headerIdx = table.findIndex((r) => r.includes("Client Code") && r.includes("Client Name"));
  if (headerIdx === -1) return { rows: [], errors: [{ row: 0, reason: "Header row not found — is this the Clients export?", raw: "" }] };

  const header = table[headerIdx];
  const col = (name: string) => header.indexOf(name);
  const iCode = col("Client Code"), iName = col("Client Name"), iNpwp = col("Npwp"),
    iAddr = col("Address"), iContact = col("Contact Person"), iEmail = col("Email");

  const rows: ClientRow[] = [];
  const errors: ImportError[] = [];
  for (let r = headerIdx + 1; r < table.length; r++) {
    const cells = table[r];
    if (!/^\d+$/.test(cells[0] ?? "")) continue; // not a data row (No. column)
    const code = stripCode(cells[iCode] ?? "");
    const name = cells[iName] ?? "";
    if (!code || blank(name)) {
      errors.push({ row: r + 1, reason: "Missing client code or name", raw: cells.join(" | ").slice(0, 200) });
      continue;
    }
    rows.push({
      clientCode: code,
      name,
      npwp: val(cells[iNpwp]),
      billingAddress: val(cells[iAddr]),
      contactPerson: val(cells[iContact]),
      email: val(cells[iEmail]),
    });
  }
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Matter_Active.xls
// ---------------------------------------------------------------------------

export interface MatterRow {
  matterCode: string;
  clientCode: string; // derived from matter code prefix
  title: string;
  practiceArea: string | null;
  feeType: "hourly" | "lump_sum" | "retainer" | "success_fee" | "internal";
  feeAmount: number | null;
  currency: "IDR" | "USD";
  handlingInitials: string | null; // -> engagement partner (first token)
  teamInitials: string[]; // all initials found on the row (matter_team)
}

const BILLING_TYPE_MAP: Record<string, MatterRow["feeType"]> = {
  "Lump Sum": "lump_sum",
  Hourly: "hourly",
  Retainer: "retainer",
  "Success Fee": "success_fee",
};

const INITIALS_STOPWORDS = new Set(["IDR", "USD", "NO", "YES", "PT", "CV", "III", "II", "IV"]);

/** Cells like "AHM" or "AHM, DPM" or "FAS,AWS,JNP,..." -> initials tokens. */
function initialsTokens(cell: string): string[] {
  if (!/^[A-Z]{2,4}(\s*,\s*[A-Z]{2,4})*$/.test(cell.trim())) return [];
  const tokens = cell.split(",").map((t) => t.trim());
  if (tokens.some((t) => INITIALS_STOPWORDS.has(t))) return [];
  return tokens;
}

export function parseMatters(content: string): { rows: MatterRow[]; errors: ImportError[] } {
  const table = parseHtmlTable(content);
  const rows: MatterRow[] = [];
  const errors: ImportError[] = [];

  for (let r = 0; r < table.length; r++) {
    const cells = table[r];
    if (!/^\d+$/.test(cells[0] ?? "")) continue;
    const raw = cells.join(" | ").slice(0, 300);

    // Leading columns are stable in the real export:
    // 0=No, 1=Matter(code), 2=Task(title), 3=Active Date, 4=Practice Area, 5=Client
    const code = stripCode(cells[1] ?? "").split(/\s+/)[0]; // "7005-06 AHM" -> "7005-06"
    if (!/^\d+-\d+/.test(code)) {
      errors.push({ row: r + 1, reason: "No recognizable matter code (ClientCode-Seq)", raw });
      continue;
    }
    const title = val(cells[2]);
    if (!title) {
      errors.push({ row: r + 1, reason: `Matter ${code}: missing Task/title`, raw });
      continue;
    }

    // Enum scans are drift-tolerant (later columns are ragged in the export).
    const billingCell = cells.find((c) => BILLING_TYPE_MAP[c.trim()]);
    const currencyCell = cells.find((c) => c.trim() === "IDR" || c.trim() === "USD");
    const moneyCells = cells.map(parseMoney).filter((m): m is number => m !== null);
    // Header order: Disbursements Estimate, Fees Estimate, Marketing Fee, ...
    const feeAmount = moneyCells.length >= 2 && moneyCells[1] > 0 ? moneyCells[1] : null;

    let handling: string | null = null;
    const team = new Set<string>();
    for (let c = 6; c < cells.length; c++) {
      const tokens = initialsTokens(cells[c]);
      if (tokens.length) {
        if (handling === null) handling = tokens[0];
        tokens.forEach((t) => team.add(t));
      }
    }

    const clientName = val(cells[5]);
    rows.push({
      matterCode: code,
      clientCode: code.split("-")[0],
      title,
      practiceArea: val(cells[4]),
      feeType: clientName?.toUpperCase().includes("SANDIVA")
        ? "internal"
        : billingCell
          ? BILLING_TYPE_MAP[billingCell.trim()]
          : "lump_sum",
      feeAmount,
      currency: currencyCell?.trim() === "USD" ? "USD" : "IDR",
      handlingInitials: handling,
      teamInitials: [...team],
    });
  }
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Report Activity Timesheets.xlsx (parsed rows come from exceljs upstream)
// ---------------------------------------------------------------------------

export interface TimeRow {
  prohukumTimeId: string;
  date: string; // ISO
  feeEarnerName: string;
  clientName: string;
  matterCode: string;
  workcode: string;
  description: string;
  units: number; // 2dp
  importedRate: number | null;
  importedAmount: number | null;
}

/** Cell matrix (header row + data rows, as raw values) -> time rows. */
export function parseTimesheetRows(matrix: (string | number | null)[][]): {
  rows: TimeRow[];
  errors: ImportError[];
} {
  const headerIdx = matrix.findIndex((r) => r.includes("Transaction ID") && r.includes("Fee Earners"));
  if (headerIdx === -1) {
    return { rows: [], errors: [{ row: 0, reason: "Header row not found — is this the Timesheet Activity report?", raw: "" }] };
  }
  const header = matrix[headerIdx].map((c) => String(c ?? ""));
  const col = (name: string) => header.findIndex((h) => h.trim() === name);
  const iTx = col("Transaction ID"), iDate = col("Timesheet Date"), iWho = col("Fee Earners"),
    iClient = col("Client"), iMatter = col("Matter"), iWork = col("Workcode"),
    iDesc = col("Description"), iUnit = col("Unit");
  const iRate = header.findIndex((h) => h.startsWith("Rate"));
  const iAmount = header.findIndex((h) => h.startsWith("Amount"));

  const rows: TimeRow[] = [];
  const errors: ImportError[] = [];
  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const cells = matrix[r];
    const no = cells[0];
    if (no === null || no === undefined || String(no).trim().toLowerCase() === "total") continue;
    if (!/^\d+$/.test(String(no).trim())) continue;
    const raw = cells.map((c) => String(c ?? "")).join(" | ").slice(0, 300);

    const tx = String(cells[iTx] ?? "").trim();
    const serial = Number(cells[iDate]);
    const who = String(cells[iWho] ?? "").trim();
    const matterCell = String(cells[iMatter] ?? "").trim();
    const matterCode = stripCode(matterCell).split(/\s+/)[0];
    const units = Math.round(Number(cells[iUnit] ?? 0) * 100) / 100;

    if (!tx) { errors.push({ row: r + 1, reason: "Missing Transaction ID", raw }); continue; }
    if (!Number.isFinite(serial) || serial < 20000) { errors.push({ row: r + 1, reason: `Tx ${tx}: bad Timesheet Date serial`, raw }); continue; }
    if (!who) { errors.push({ row: r + 1, reason: `Tx ${tx}: missing Fee Earner`, raw }); continue; }
    if (!/^\d+-\d+/.test(matterCode)) { errors.push({ row: r + 1, reason: `Tx ${tx}: unrecognizable matter "${matterCell}"`, raw }); continue; }
    if (!units || units <= 0) { errors.push({ row: r + 1, reason: `Tx ${tx}: zero/invalid Unit`, raw }); continue; }

    const rate = Number(cells[iRate]);
    const amount = Number(cells[iAmount]);
    rows.push({
      prohukumTimeId: tx,
      date: excelSerialToISO(serial),
      feeEarnerName: fixMojibake(who),
      clientName: fixMojibake(String(cells[iClient] ?? "").trim()),
      matterCode,
      workcode: String(cells[iWork] ?? "").trim() || "Coordination",
      description: fixMojibake(String(cells[iDesc] ?? "").replace(/\s+/g, " ").trim()),
      units,
      importedRate: Number.isFinite(rate) ? Math.round(rate * 100) / 100 : null,
      importedAmount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null,
    });
  }
  return { rows, errors };
}
