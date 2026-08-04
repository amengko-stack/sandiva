import { deriveVerdict, verdictLabel } from "@/lib/dd/report-boilerplate";
import type { DDNarrativeBlock } from "@/lib/dd/narrative-render";
import { DD_DEFAULT_REPORT_OPTIONS } from "@/types/dd";
import type { DDFinding, DDReportOptions, DDSeverity } from "@/types/dd";

/**
 * Renders a chapter's "Temuan" sub-section in the house presentation: a lead-in
 * sentence stating the count, then a dense findings table.
 *
 * On the risk column. The Makarim precedents and the HKHSK standard use no risk
 * rating at all, and I first read that as a rule and hardcoded its absence. The
 * firm's own reports disagree, and the evidence is mixed rather than one-sided:
 *
 *   LDD_Report_SBN_Divestment  — no risk column
 *   LDD_PT_ITDC_Nusantara      — "Tingkat Risiko" in plain words ("Rendah-Sedang")
 *   LDD_SIIB_Pembubaran_v4     — "Tingkat Risiko" with codes ("Sedang [S]")
 *
 * So it is a per-report choice. The default stays "off", matching the
 * convention and the standard's three-state conclusion, with both house
 * notations available when a client expects one.
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
      f.editedProblem ?? f.problem,
      f.regulationRefs && f.regulationRefs.length > 0 ? f.regulationRefs.join("; ") : NO_DEFECT,
    ];
    if (showRisk) row.push(riskLabel(f.severity, options.riskColumn));
    if (showConsequence) row.push(f.legalConsequence || "—");
    row.push(f.suggestedFix);
    return row;
  });

  return [
    {
      kind: "para",
      text: `Berdasarkan pemeriksaan atas Dokumen Yang Diperiksa, terdapat ${countLabel} yang dilaporkan pada bagian ini. Rincian sebagai berikut:`,
    },
    { kind: "table", headers, rows },
  ];
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
