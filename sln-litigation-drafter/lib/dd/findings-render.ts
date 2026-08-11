import { deriveVerdict, verdictLabel } from "@/lib/dd/report-boilerplate";
import type { DDNarrativeBlock } from "@/lib/dd/narrative-render";
import { DD_DEFAULT_REPORT_OPTIONS } from "@/types/dd";
import { isUngrounded } from "@/lib/dd/grounding";
import type { DDFinding, DDReportOptions, DDSeverity } from "@/types/dd";

/**
 * Renders a chapter's "Temuan" sub-section in the house presentation: a lead-in
 * sentence stating the count, then a dense findings table.
 *
 * On the risk column, and a correction worth recording.
 *
 * This comment used to argue that "the firm's own reports disagree" with the
 * convention, citing LDD_Report_SBN_Divestment (no column), LDD_PT_ITDC_Nusantara
 * (plain words) and LDD_SIIB_Pembubaran_v4 (bracket codes). The user has since
 * confirmed that all three of those documents are themselves Claude output. They
 * are not evidence of how this firm writes; citing them was circular — validating a
 * design decision against artefacts produced by the same system.
 *
 * What actually supports the default: the Makarim precedents and the HKHSK standard
 * use no risk rating at all (verified: zero occurrences across three precedents and
 * the standard's notes), and the user stated it directly — "LDD convention Indonesia
 * tidak menggunakan tingkat risiko".
 *
 * So the default is "off" on two independent grounds. The two notations remain
 * available as options a client may specifically ask for — not because any firm
 * precedent uses them.
 *
 * The internal DDSeverity scale always orders rows so the most serious read
 * first; it is only PRINTED when a risk column is switched on.
 */

const SEVERITY_ORDER: Record<DDSeverity, number> = {
  kritis: 0,
  material: 1,
  minor: 2,
};

/** House mapping from the internal scale to the words the reports use. */
const RISK_WORD: Record<DDSeverity, string> = {
  kritis: "Tinggi",
  material: "Sedang",
  minor: "Rendah",
};

const RISK_CODE: Record<DDSeverity, string> = {
  kritis: "Tinggi [T]",
  material: "Sedang [S]",
  minor: "Rendah [R]",
};

const NO_DEFECT = "Tidak ada cacat formal";

/**
 * A finding whose quote was not found in the document it names must not be
 * presented as established fact. It is MARKED rather than dropped: the model may
 * have spotted something real and quoted it badly, and discarding it would lose
 * that, whereas asserting it unmarked would be exactly the invention the report
 * must avoid. The lawyer decides.
 */
const UNVERIFIED_PREFIX = "[TIDAK TERVERIFIKASI TERHADAP DOKUMEN] ";

function problemText(f: DDFinding): string {
  const base = f.editedProblem ?? f.problem;
  if (f.grounding && isUngrounded(f.grounding.verdict)) {
    return UNVERIFIED_PREFIX + base;
  }
  return base;
}

export function riskLabel(severity: DDSeverity, mode: DDReportOptions["riskColumn"]): string {
  if (mode === "kata") return RISK_WORD[severity];
  if (mode === "kode") return RISK_CODE[severity];
  return "";
}

function sortBySeverity(findings: DDFinding[]): DDFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** No `docx` import — pure text/table blocks, so this stays unit-testable. */
export function renderFindingsTable(
  findings: DDFinding[],
  options: DDReportOptions = DD_DEFAULT_REPORT_OPTIONS
): DDNarrativeBlock[] {
  const active = findings.filter((f) => f.status !== "dismissed");
  if (active.length === 0) return [];

  const ordered = sortBySeverity(active);
  const count = active.length;
  const countLabel = count === 1 ? "satu hal" : `${count} hal`;

  const showRisk = options.riskColumn !== "off";
  const showConsequence = options.legalConsequenceColumn;

  const headers = ["No.", "Temuan", "Pasal yang Relevan"];
  if (showRisk) headers.push("Tingkat Risiko");
  if (showConsequence) headers.push("Konsekuensi Hukum");
  headers.push("Rekomendasi");

  const rows = ordered.map((f, i) => {
    const row = [
      String(i + 1),
      problemText(f),
      f.regulationRefs && f.regulationRefs.length > 0 ? f.regulationRefs.join("; ") : NO_DEFECT,
    ];
    if (showRisk) row.push(riskLabel(f.severity, options.riskColumn));
    if (showConsequence) row.push(f.legalConsequence || "—");
    row.push(f.suggestedFix);
    return row;
  });

  const ungrounded = ordered.filter(
    (f) => f.grounding && isUngrounded(f.grounding.verdict)
  ).length;

  const out: DDNarrativeBlock[] = [
    {
      kind: "para",
      text: `Berdasarkan pemeriksaan atas Dokumen Yang Diperiksa, terdapat ${countLabel} yang dilaporkan pada bagian ini. Rincian sebagai berikut:`,
    },
    { kind: "table", headers, rows },
  ];

  if (ungrounded > 0) {
    out.push({
      kind: "note",
      text:
        `${ungrounded} butir di atas ditandai "[TIDAK TERVERIFIKASI TERHADAP DOKUMEN]": kutipan yang ` +
        `mendasarinya tidak ditemukan dalam dokumen yang dirujuk pada pemeriksaan otomatis. Butir tersebut ` +
        `belum dapat dinyatakan sebagai fakta dan wajib ditelaah terhadap dokumen aslinya sebelum diandalkan.`,
    });
  }
  return out;
}

/**
 * One sentence in the standard's mandated three-state form. This is always
 * emitted, including when a risk column is shown — the column is a client
 * convenience, the three-state conclusion is what the standard requires.
 */
export function renderVerdictLine(findings: DDFinding[]): string {
  const verdict = deriveVerdict(findings.map((f) => ({ severity: f.severity, status: f.status })));
  return `Berdasarkan Dokumen Yang Diperiksa, aspek ini ${verdictLabel(verdict)}.`;
}
