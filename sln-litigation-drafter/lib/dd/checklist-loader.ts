import ExcelJS from "exceljs";
import { readSiteFileBytes, writeMatterFile } from "@/lib/graph-client";
import { SEED_CHECKLIST } from "@/config/ddChecklist.seed";
import { DD_ASPECTS } from "@/config/ddAspects";
import { DD_TRANSACTION_TYPES } from "@/config/ddTransactionTypes";
import type {
  DDAspectId, DDCellType, DDChecklist, DDExpectedDoc, DDExtractionField,
  DDImportance, DDRegime, DDRegimeLayer, DDTransactionType, ResolvedChecklist,
} from "@/types/dd";

export const CHECKLIST_DIR = "SLN-AI/due-diligence";
export const CHECKLIST_FILE = "checklist.xlsx";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const ASPECT_IDS = new Set<string>(DD_ASPECTS.map((a) => a.id));
const IMPORTANCE = new Set(["wajib", "penting", "opsional"]);
const CELL_TYPES = new Set(["text", "date", "currency", "number", "verbatim", "category", "boolean"]);
const TRANSACTION_TYPE_IDS = new Set<string>(DD_TRANSACTION_TYPES.map((t) => t.id));

const splitList = (v: unknown): string[] =>
  String(v ?? "").split(";").map((s) => s.trim()).filter(Boolean);

const cellStr = (row: ExcelJS.Row, col: number): string => {
  const v = row.getCell(col).value;
  if (v == null) return "";
  if (typeof v === "object" && "text" in (v as object)) return String((v as { text: unknown }).text).trim();
  return String(v).trim();
};

export async function buildChecklistWorkbook(cl: DDChecklist): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const info = wb.addWorksheet("Info");
  info.addRow(["version", cl.version]);
  info.addRow(["updatedAt", cl.updatedAt]);

  const sheet = wb.addWorksheet("Checklist");
  sheet.addRow(["ID", "Aspek", "Dokumen", "Kepentingan", "KataKunci", "MasaBerlakuTahun", "JenisTransaksi"]);
  const writeDoc = (d: DDExpectedDoc, txns: string) =>
    sheet.addRow([
      d.id, d.aspectId, d.label, d.importance, d.keywords.join(";"),
      d.expiryRule?.kind === "fixed_years" ? d.expiryRule.years ?? "" : "",
      txns,
    ]);
  for (const d of cl.base) writeDoc(d, "");
  // One row per unique overlay doc; appliesTo wins, otherwise accumulate the
  // overlay keys the doc is stored under (a doc may appear in several buckets).
  const overlayById = new Map<string, { doc: DDExpectedDoc; txns: Set<string> }>();
  for (const [txn, docs] of Object.entries(cl.overlays)) {
    for (const d of docs ?? []) {
      const entry = overlayById.get(d.id) ?? { doc: d, txns: new Set<string>() };
      for (const t of d.appliesTo ?? [txn]) entry.txns.add(t);
      overlayById.set(d.id, entry);
    }
  }
  for (const { doc, txns } of Array.from(overlayById.values())) writeDoc(doc, Array.from(txns).join(";"));

  const ext = wb.addWorksheet("KolomEkstraksi");
  ext.addRow(["ID", "Label", "Tipe", "Prompt", "KataKunciPerjanjian", "PemicuTransaksi"]);
  for (const f of cl.extractionFields) {
    ext.addRow([f.id, f.label, f.type, f.prompt, f.appliesToKeywords.join(";"), (f.dealTriggerFor ?? []).join(";")]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function parseChecklistWorkbook(buf: Buffer): Promise<DDChecklist> {
  const wb = new ExcelJS.Workbook();
  // exceljs's own .d.ts declares a module-local ambient `Buffer extends ArrayBuffer`
  // that Node's real Buffer doesn't structurally satisfy under our tsconfig's
  // "esnext" lib (resizable-ArrayBuffer members) — cast is a typings-only workaround,
  // runtime behavior is unaffected (exceljs accepts a Node Buffer here).
  await wb.xlsx.load(buf as any);

  const sheet = wb.getWorksheet("Checklist");
  if (!sheet) throw new Error('checklist.xlsx tidak memiliki sheet "Checklist" — periksa file di SharePoint.');
  const ext = wb.getWorksheet("KolomEkstraksi");
  if (!ext) throw new Error('checklist.xlsx tidak memiliki sheet "KolomEkstraksi" — periksa file di SharePoint.');
  const info = wb.getWorksheet("Info");

  const base: DDExpectedDoc[] = [];
  const overlays: DDChecklist["overlays"] = {};
  sheet.eachRow((row, n) => {
    if (n === 1) return; // header
    const id = cellStr(row, 1);
    if (!id) return;
    const aspectId = cellStr(row, 2);
    const importance = cellStr(row, 4);
    if (!ASPECT_IDS.has(aspectId)) throw new Error(`Baris ${n}: Aspek "${aspectId}" tidak dikenal.`);
    if (!IMPORTANCE.has(importance)) throw new Error(`Baris ${n}: Kepentingan "${importance}" tidak dikenal.`);
    const years = Number(cellStr(row, 6));
    const txns = splitList(cellStr(row, 7)) as DDTransactionType[];
    for (const t of txns) {
      if (!TRANSACTION_TYPE_IDS.has(t)) throw new Error(`Baris ${n}: JenisTransaksi "${t}" tidak dikenal.`);
    }
    const doc: DDExpectedDoc = {
      id,
      aspectId: aspectId as DDAspectId,
      label: cellStr(row, 3),
      importance: importance as DDImportance,
      keywords: splitList(cellStr(row, 5)),
      ...(years > 0 ? { expiryRule: { kind: "fixed_years" as const, years } } : {}),
      ...(txns.length ? { appliesTo: txns } : {}),
      source: txns.length ? ("overlay" as const) : ("base" as const),
    };
    if (txns.length) {
      for (const t of txns) (overlays[t] ??= []).push(doc);
    } else {
      base.push(doc);
    }
  });

  const extractionFields: DDExtractionField[] = [];
  ext.eachRow((row, n) => {
    if (n === 1) return;
    const id = cellStr(row, 1);
    if (!id) return;
    const type = cellStr(row, 3);
    if (!CELL_TYPES.has(type)) throw new Error(`KolomEkstraksi baris ${n}: Tipe "${type}" tidak dikenal.`);
    const triggers = splitList(cellStr(row, 6)) as DDTransactionType[];
    for (const t of triggers) {
      if (!TRANSACTION_TYPE_IDS.has(t)) {
        throw new Error(`KolomEkstraksi baris ${n}: PemicuTransaksi "${t}" tidak dikenal.`);
      }
    }
    extractionFields.push({
      id, label: cellStr(row, 2), type: type as DDCellType, prompt: cellStr(row, 4),
      appliesToKeywords: splitList(cellStr(row, 5)),
      ...(triggers.length ? { dealTriggerFor: triggers } : {}),
    });
  });

  return {
    version: info ? cellStr(info.getRow(1), 2) || "sharepoint" : "sharepoint",
    updatedAt: info ? cellStr(info.getRow(2), 2) || new Date().toISOString() : new Date().toISOString(),
    base, overlays, extractionFields,
  };
}

// SharePoint file → checklist; missing file → seed; malformed file → throw
// (same discipline as loadJurisprudenceDb — a transient error must never be
// treated as "empty checklist", which would flag everything as unexpected).
export async function loadChecklist(): Promise<DDChecklist> {
  const buf = await readSiteFileBytes(`${CHECKLIST_DIR}/${CHECKLIST_FILE}`);
  if (buf === null) return SEED_CHECKLIST;
  return parseChecklistWorkbook(buf);
}

export function resolveChecklist(
  cl: DDChecklist,
  txn: DDTransactionType,
  tailored?: DDExpectedDoc[],
  regime?: DDRegime
): ResolvedChecklist {
  // No regime passed = old behavior exactly: no regime-overlay docs are
  // contributed, and any doc with requiresLayer set is filtered out below
  // (activeLayers stays empty, so the "shares no layer" test always excludes it).
  const activeLayers: DDRegimeLayer[] = regime?.layers ?? [];
  const regimeDocs: DDExpectedDoc[] = [];
  for (const layer of activeLayers) {
    for (const d of cl.regimeOverlays?.[layer] ?? []) regimeDocs.push(d);
  }

  // Later sources win for a given id; Map preserves first-seen key order, so
  // ordering stays deterministic: base, then transaction overlay, then each
  // active regime layer (in regime.layers order), then tailored docs.
  const byId = new Map<string, DDExpectedDoc>();
  for (const d of [...cl.base, ...(cl.overlays[txn] ?? []), ...regimeDocs, ...(tailored ?? [])]) {
    byId.set(d.id, d);
  }

  const activeLayerSet = new Set<DDRegimeLayer>(activeLayers);
  const expected = Array.from(byId.values()).filter(
    (d) => !d.requiresLayer || d.requiresLayer.some((l) => activeLayerSet.has(l))
  );

  return { version: cl.version, expected, extractionFields: cl.extractionFields };
}

export async function generateChecklistTemplate(): Promise<void> {
  // Distinct version so a template-generated file reads back as "sharepoint",
  // not "seed" — the /api/dd/checklist source flag depends on it.
  const buf = await buildChecklistWorkbook({
    ...SEED_CHECKLIST,
    version: "sharepoint-1",
    updatedAt: new Date().toISOString(),
  });
  await writeMatterFile(CHECKLIST_DIR, CHECKLIST_FILE, buf, XLSX_MIME);
}
