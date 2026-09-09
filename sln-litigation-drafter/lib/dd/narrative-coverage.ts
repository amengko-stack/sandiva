import { createHash } from "node:crypto";
import type { DDNarrativeCoverage, DDNarrativeNote, DDNarrativeSectionI } from "@/types/dd";

export const NARRATIVE_CHAR_CAP = 100_000;
const ASPECTS = new Set(["pendirian_ad", "permodalan_saham", "pengurus"]);
const STATUSES = new Set(["selesai", "perlu_ocr", "gagal"]);
const REASONS = new Set([
  "input_limit", "extraction_uncertain", "unreadable", "missing_text", "no_relevant_documents",
  "no_usable_input", "legacy", "invalid_coverage", "stale_input", "entity_mismatch",
]);
const record = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const date = (x: unknown): x is string => typeof x === "string" && Number.isFinite(Date.parse(x));

export function parseStoredJson(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

/** Sort object keys, preserving array/source order. Inputs come from JSON, not model output. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (record(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`;
  return JSON.stringify(x ?? null);
}

export interface NarrativeInput {
  entityId: string;
  entityName: string;
  classified: unknown;
  contentByFile: Map<string, string>;
  extractReport?: unknown;
}

export function validNarrativeClassification(value: unknown, entityId: string): boolean {
  return Array.isArray(value) && value.every((d) => record(d) && d.entityId === entityId &&
    typeof d.fileName === "string" && d.fileName.length > 0 && typeof d.aspectId === "string");
}

/** Never split an astral character at the source-budget boundary. */
export function sourcePrefix(text: string, limit: number): string {
  let end = Math.max(0, Math.min(text.length, limit));
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}

export function prepareNarrativeInput(args: NarrativeInput) {
  if (!validNarrativeClassification(args.classified, args.entityId)) {
    throw new Error("Klasifikasi dokumen tidak sesuai dengan entitas ini.");
  }
  const classified = args.classified as { fileName: string; aspectId: string }[];
  const relevant = new Set(classified.filter((d) => ASPECTS.has(d.aspectId)).map((d) => d.fileName));
  const report = args.extractReport;
  const rows = record(report) && Array.isArray(report.files) ? report.files : [];
  const reportValid = record(report) && Array.isArray(report.files) && rows.every((r) =>
    record(r) && typeof r.name === "string" && r.name.length > 0 && typeof r.status === "string" && STATUSES.has(r.status));
  const statuses = new Map<string, string>();
  for (const r of rows) {
    if (!record(r) || typeof r.name !== "string") continue;
    const status = typeof r.status === "string" ? r.status : "unknown";
    const prior = statuses.get(r.name);
    // Identical records retain known unreadability; contradictory records cannot supply stale text.
    statuses.set(r.name, prior === undefined || prior === status ? status : "conflicting");
  }
  const names = new Set(relevant);
  for (const [name, status] of Array.from(statuses)) if (status !== "selesai") names.add(name);
  const limitations = new Set<string>();
  if (!reportValid) limitations.add("extraction_uncertain");
  if (!relevant.size) limitations.add("no_relevant_documents");
  const supplied = new Map<string, string>();
  let docsText = "";
  let budgetExhausted = false;
  const files: DDNarrativeCoverage["files"] = [];
  for (const fileName of Array.from(names)) {
    const text = args.contentByFile.get(fileName) ?? "";
    const status = statuses.get(fileName);
    const availability = status === "perlu_ocr" || status === "gagal" ? status
      : !text.trim() ? status === "selesai" ? "supplied_missing_text" : "missing_text"
      : reportValid && status === "selesai" ? "usable" : "unknown";
    if (availability === "perlu_ocr" || availability === "gagal") limitations.add("unreadable");
    if (availability === "missing_text" || availability === "supplied_missing_text") limitations.add("missing_text");
    if (availability === "unknown") limitations.add("extraction_uncertain");
    // Known extraction failures are never passed off as usable text, even if a stale block exists.
    const eligible = relevant.has(fileName) && text.trim().length > 0 && availability !== "perlu_ocr" && availability !== "gagal" && status !== "conflicting";
    let included = "";
    if (eligible) {
      const header = `${docsText ? "\n\n" : ""}=== ${fileName} ===\n`;
      if (!budgetExhausted) included = sourcePrefix(text, NARRATIVE_CHAR_CAP - docsText.length - header.length);
      // Header-only fragments are not source content. Stop at the first omitted body.
      if (included.length) {
        docsText += header + included;
        supplied.set(fileName, included);
      }
      if (included.length < text.length) { limitations.add("input_limit"); budgetExhausted = true; }
    }
    files.push({ fileName, relevant: relevant.has(fileName), availability,
      availableChars: eligible ? text.length : 0, includedChars: included.length });
  }
  const availableChars = files.reduce((n, f) => n + f.availableChars, 0);
  const includedChars = files.reduce((n, f) => n + f.includedChars, 0);
  if (!includedChars) limitations.add("no_usable_input");
  const sourceFingerprint = createHash("sha256").update(canonical({
    entityId: args.entityId, entityName: args.entityName, classified: args.classified,
    content: Array.from(args.contentByFile).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), report,
  })).digest("hex");
  const coverage: DDNarrativeCoverage = {
    version: 1, entityId: args.entityId, sourceFingerprint,
    status: !includedChars ? "unavailable" : limitations.size ? "partial" : "full_supplied_input",
    availableChars, includedChars, promptSourceChars: docsText.length, files,
    modelCompletion: includedChars ? "end_turn" : "not_called", limitations: Array.from(limitations),
    generatedAt: new Date().toISOString(),
  };
  return { docsText, contentByFile: supplied, coverage };
}

/** Persisted data is unknown, including objects written before this schema existed. */
export function parseNarrativeCoverage(value: unknown): DDNarrativeCoverage | null {
  if (!record(value) || value.version !== 1 || typeof value.entityId !== "string" ||
    typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint) ||
    !["full_supplied_input", "partial", "unavailable", "legacy_unassessed"].includes(String(value.status)) ||
    !["end_turn", "not_called", "unassessed"].includes(String(value.modelCompletion)) || !date(value.generatedAt) ||
    !count(value.availableChars) || !count(value.includedChars) || !count(value.promptSourceChars) ||
    value.includedChars > value.availableChars || value.promptSourceChars > NARRATIVE_CHAR_CAP ||
    value.includedChars > value.promptSourceChars || !Array.isArray(value.files) || !Array.isArray(value.limitations) ||
    !value.limitations.every((r) => typeof r === "string" && REASONS.has(r))) return null;
  const names = new Set<string>();
  for (const f of value.files) {
    if (!record(f) || typeof f.fileName !== "string" || !f.fileName || names.has(f.fileName) ||
      typeof f.relevant !== "boolean" || !["usable", "perlu_ocr", "gagal", "supplied_missing_text", "missing_text", "unknown"].includes(String(f.availability)) ||
      !count(f.availableChars) || !count(f.includedChars) || f.includedChars > f.availableChars ||
      (!f.relevant && (f.availableChars !== 0 || f.includedChars !== 0))) return null;
    names.add(f.fileName);
  }
  const c = value as unknown as DDNarrativeCoverage;
  if (c.files.reduce((n, f) => n + f.includedChars, 0) !== c.includedChars ||
      c.files.reduce((n, f) => n + f.availableChars, 0) !== c.availableChars) return null;
  if (c.status === "full_supplied_input" && (c.limitations.length || !c.includedChars ||
    c.includedChars !== c.availableChars || c.modelCompletion !== "end_turn" || c.files.some((f) => f.availability !== "usable"))) return null;
  if (c.status === "unavailable" && (c.includedChars !== 0 || c.modelCompletion !== "not_called")) return null;
  if (c.status === "partial" && (!c.includedChars || !c.limitations.length || c.modelCompletion !== "end_turn")) return null;
  return c;
}

export function coverageNotes(value: unknown): DDNarrativeNote[] {
  const c = parseNarrativeCoverage(value);
  const texts: string[] = [];
  if (!c || c.status === "legacy_unassessed") {
    texts.push(c?.limitations.includes("stale_input")
      ? "Dokumen atau klasifikasi telah berubah sejak narasi ini disimpan. Narasi ini merupakan hasil sebelumnya; cakupannya belum dinilai terhadap dokumen terkini. [PERLU VERIFIKASI]"
      : "Cakupan pemrosesan narasi tersimpan ini belum tercatat atau belum dapat dipastikan. Jalankan ulang penyusunan Profil Perseroan untuk memperoleh catatan cakupan. [PERLU VERIFIKASI]");
  } else {
    if (c.status === "full_supplied_input") texts.push("Seluruh teks yang tersedia untuk aspek Profil Perseroan telah disertakan dalam penyusunan. Catatan ini menunjukkan cakupan pemrosesan, bukan verifikasi atau kesimpulan kelengkapan hukum.");
    if (c.limitations.includes("input_limit")) texts.push("Pemeriksaan Profil Perseroan belum mencakup seluruh teks dokumen yang tersedia karena batas pemrosesan. Bagian dokumen yang belum diperiksa tercantum pada catatan cakupan berikut. [PERLU VERIFIKASI]");
    if (c.limitations.includes("extraction_uncertain")) texts.push("Status ekstraksi sebagian dokumen belum dapat dipastikan. Teks yang tersedia dapat digunakan secara terbatas; kelengkapan isinya belum dapat dikonfirmasi. [PERLU VERIFIKASI]");
    if (c.limitations.includes("no_relevant_documents")) texts.push("Belum ada dokumen yang diklasifikasikan pada aspek pendirian, permodalan, atau pengurus. Hal ini tidak menyatakan bahwa dokumen tersebut tidak pernah disediakan.");
    if (c.limitations.includes("no_usable_input")) texts.push("Profil Perseroan belum dapat disusun karena tidak ada teks yang dapat diperiksa untuk aspek tersebut. Tidak dilakukan penyusunan fakta korporasi.");
    for (const f of c.files) {
      if (f.availability === "perlu_ocr") texts.push(`${f.fileName}: dokumen ini telah disediakan dan memerlukan OCR; isinya belum dapat diperiksa. [PERLU VERIFIKASI]`);
      else if (f.availability === "gagal") texts.push(`${f.fileName}: dokumen ini telah disediakan, tetapi teksnya belum berhasil diekstrak; isinya belum diperiksa. [PERLU VERIFIKASI]`);
      else if (f.availability === "supplied_missing_text") texts.push(`${f.fileName}: dokumen ini telah disediakan dan tercatat telah diekstrak, tetapi teksnya tidak tersedia untuk penyusunan Profil Perseroan; isinya belum diperiksa dalam narasi ini. [PERLU VERIFIKASI]`);
      else if (f.availability === "missing_text") texts.push(`${f.fileName}: rujukan dokumen tercatat, tetapi teksnya belum tersedia untuk diperiksa. Keberadaan dan status ekstraksinya perlu dikonfirmasi. [PERLU VERIFIKASI]`);
      if (f.availableChars > f.includedChars) texts.push(`${f.fileName}: ${f.includedChars} dari ${f.availableChars} karakter teks disertakan; ${f.availableChars - f.includedChars} karakter teks belum diperiksa.`);
    }
  }
  return texts.map((text) => ({ anchor: "lainnya", text, sourceFile: null }));
}

export function emptyNarrative(entityId: string, generatedAt: string): DDNarrativeSectionI {
  return { entityId, establishment: null, amendments: [], businessPurpose: "", businessActivities: [],
    businessBasis: "", capitalHistory: [], currentCapital: null, shareholders: [], directors: [], commissioners: [],
    notes: [], generatedAt };
}

export function priorNarrativeTime(value: unknown, entityId: string): string | null {
  return validNarrative(value, entityId) ? value.generatedAt : null;
}

function validNarrative(value: unknown, entityId: string): value is DDNarrativeSectionI {
  const strings = (x: unknown, keys: string[]) => record(x) && keys.every((k) => typeof x[k] === "string");
  const deedKeys = ["number", "dateISO", "notary", "purpose", "menkumhamRef", "registrationRef", "bnriRef", "sourceFile", "verbatim"];
  const capitalKeys = ["basis", "authorized", "issued", "paidUp", "shareCount", "nominalPerShare", "sourceFile"];
  if (!record(value) || value.entityId !== entityId || !date(value.generatedAt) ||
      !strings(value, ["businessPurpose", "businessBasis"]) ||
      !(value.establishment === null || strings(value.establishment, deedKeys)) ||
      !(value.currentCapital === null || strings(value.currentCapital, capitalKeys)) ||
      !Array.isArray(value.businessActivities) || !value.businessActivities.every((x) => typeof x === "string")) return false;
  for (const [key, keys] of [
    ["amendments", deedKeys], ["capitalHistory", capitalKeys],
    ["shareholders", ["name", "shares", "amount", "percentage", "sourceFile"]],
    ["directors", ["role", "name", "appointedBy", "termUntil", "sourceFile"]],
    ["commissioners", ["role", "name", "appointedBy", "termUntil", "sourceFile"]],
  ] as [string, string[]][]) {
    if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every((x) => strings(x, keys))) return false;
  }
  return Array.isArray(value.notes) && value.notes.every((x) => record(x) && typeof x.text === "string" &&
    ["pendirian", "anggaran_dasar", "kegiatan_usaha", "permodalan", "pemegang_saham", "pengurus", "lainnya"].includes(String(x.anchor)) &&
    (x.sourceFile === null || typeof x.sourceFile === "string"));
}

/** Reconcile at the shared reload/export boundary without modifying persisted artifacts. */
export function reconcileNarrative(value: unknown, args: NarrativeInput): DDNarrativeSectionI | null {
  if (value == null) return null;
  const c = record(value) ? parseNarrativeCoverage(value.coverage) : null;
  let current: DDNarrativeCoverage | null = null;
  try { current = prepareNarrativeInput(args).coverage; } catch { /* Unusable current classification stays unassessed. */ }
  const sameEntity = record(value) && value.entityId === args.entityId;
  const shape = validNarrative(value, args.entityId);
  const narrative = shape ? value as unknown as DDNarrativeSectionI : emptyNarrative(args.entityId, new Date().toISOString());
  const measured = (x: DDNarrativeCoverage) => canonical({ ...x, generatedAt: null });
  if (shape && c && current && c.entityId === args.entityId && c.generatedAt === narrative.generatedAt && measured(c) === measured(current)) {
    return { ...narrative, coverage: c };
  }
  const reason = !sameEntity ? "entity_mismatch" : !c ? (record(value) && value.coverage === undefined ? "legacy" : "invalid_coverage") : "stale_input";
  return { ...narrative, coverage: {
    version: 1, entityId: args.entityId, sourceFingerprint: current?.sourceFingerprint ?? "0".repeat(64),
    status: "legacy_unassessed", availableChars: 0, includedChars: 0, promptSourceChars: 0, files: [],
    modelCompletion: "unassessed", limitations: [reason], generatedAt: narrative.generatedAt,
  } };
}
