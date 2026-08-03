import { deriveVerdict, verdictLabel } from "@/lib/dd/report-boilerplate";
import type { DDNarrativeBlock } from "@/lib/dd/narrative-render";
import type { DDFinding, DDSeverity } from "@/types/dd";

/**
 * Renders a chapter's "Temuan" sub-section in the house presentation: a
 * lead-in sentence stating the count, then a dense findings table. Confirmed
 * against LDD_SIIB_Pembubaran_FINAL_v4.docx §3.5 "Temuan & Risiko Korporasi"
 * and §7.1.1 "Project Canyon" — EXCEPT that report's "Tingkat Risiko"
 * ([T]/[S]/[R]) column, which is that report's own house invention and must
 * NOT be reproduced. Rows are ordered by the internal DDSeverity scale
 * (kritis, material, minor) so the most serious read first, but the severity
 * itself is never printed anywhere in the output.
 */

const SEVERITY_ORDER: Record<DDSeverity, number> = {
  kritis: 0,
  material: 1,
  minor: 2,
};

const NO_DEFECT = "Tidak ada cacat formal";

function sortBySeverity(findings: DDFinding[]): DDFinding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** No `docx` import — pure text/table blocks, so this stays unit-testable. */
export function renderFindingsTable(findings: DDFinding[]): DDNarrativeBlock[] {
  const active = findings.filter((f) => f.status !== "dismissed");
  if (active.length === 0) return [];

  const ordered = sortBySeverity(active);
  const count = active.length;
  const countLabel = count === 1 ? "satu hal" : `${count} hal`;

  const out: DDNarrativeBlock[] = [
    {
      kind: "para",
      text: `Berdasarkan pemeriksaan atas Dokumen Yang Diperiksa, terdapat ${countLabel} yang dilaporkan pada bagian ini. Rincian sebagai berikut:`,
    },
    {
      kind: "table",
      headers: ["No.", "Temuan", "Pasal yang Relevan", "Konsekuensi Hukum", "Rekomendasi"],
      rows: ordered.map((f, i) => [
        String(i + 1),
        f.editedProblem ?? f.problem,
        f.regulationRefs && f.regulationRefs.length > 0 ? f.regulationRefs.join("; ") : NO_DEFECT,
        f.legalConsequence || "—",
        f.suggestedFix,
      ]),
    },
  ];
  return out;
}

/**
 * One sentence in the standard's mandated three-state form — replaces any
 * risk rating. e.g. "Berdasarkan Dokumen Yang Diperiksa, aspek ini memenuhi
 * ketentuan dengan catatan."
 */
export function renderVerdictLine(findings: DDFinding[]): string {
  const verdict = deriveVerdict(findings.map((f) => ({ severity: f.severity, status: f.status })));
  return `Berdasarkan Dokumen Yang Diperiksa, aspek ini ${verdictLabel(verdict)}.`;
}
