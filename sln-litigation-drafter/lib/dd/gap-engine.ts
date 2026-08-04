import { gapRationaleFor } from "@/config/ddGapRationale";
import type {
  DDClassifiedDoc, DDExpectedDoc, DDFinding, DDGapItem, DDGapStatus,
  DDImportance, DDSeverity, DDTransactionType,
} from "@/types/dd";

export function severityFor(importance: DDImportance): DDSeverity {
  return importance === "wajib" ? "kritis" : importance === "penting" ? "material" : "minor";
}

// docDate is "YYYY-MM-DD" | "YYYY-MM" | "YYYY" | null. Compare by year+padding.
function toComparable(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(dateStr.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 12;
  // missing parts = latest possible: missing day = last day of that month
  // (Date.UTC month is 0-based; day 0 of next month = last day of the target month)
  const day = m[3] ? Number(m[3]) : new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${m[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isExpired(latestDate: string, years: number, cutoffISO: string): boolean {
  const d = new Date(latestDate + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime() < new Date(cutoffISO + "T00:00:00Z").getTime();
}

export function computeGaps(args: {
  expected: DDExpectedDoc[];
  classified: DDClassifiedDoc[];
  entityId: string;
  transactionType: DDTransactionType;
  cutoffDateISO: string;
  notApplicableIds?: string[];
}): DDGapItem[] {
  const { expected, classified, entityId, transactionType, cutoffDateISO } = args;
  const na = new Set(args.notApplicableIds ?? []);

  const applicable = expected.filter(
    (e) => !e.appliesTo || e.appliesTo.includes(transactionType)
  );

  return applicable.map((e) => {
    const matches = classified.filter((c) => c.expectedDocId === e.id);
    let status: DDGapStatus;
    let note = "";

    if (na.has(e.id)) {
      status = "not_applicable";
      note = "Ditandai tidak relevan untuk transaksi/entitas ini — perlu konfirmasi reviewer.";
    } else if (matches.length === 0) {
      status = "missing";
      note = "Tidak ditemukan dalam data room.";
    } else if (matches.every((m) => m.confidence === "rendah")) {
      status = "incomplete";
      note = "Hanya ditemukan dokumen dengan keyakinan rendah — kemungkinan tidak lengkap.";
    } else {
      status = "present";
      if (e.expiryRule?.kind === "fixed_years" && e.expiryRule.years) {
        const dates = matches
          .map((m) => toComparable(m.docDate))
          .filter((d): d is string => d !== null)
          .sort();
        const latest = dates[dates.length - 1];
        if (latest && isExpired(latest, e.expiryRule.years, cutoffDateISO)) {
          status = "expired";
          note = `Dokumen terbaru bertanggal ${latest} — melewati masa berlaku ${e.expiryRule.years} tahun per tanggal uji ${cutoffDateISO}.`;
        }
      }
    }

    return {
      entityId,
      aspectId: e.aspectId,
      expectedDocId: e.id,
      expectedLabel: e.label,
      status,
      matchedFiles: matches.map((m) => m.fileName),
      severity: severityFor(e.importance),
      note,
    };
  });
}

const STATUS_PROBLEM: Record<Exclude<DDGapStatus, "present">, string> = {
  missing: "Dokumen tidak ditemukan dalam Dokumen Yang Diperiksa",
  incomplete: "Dokumen kemungkinan tidak lengkap",
  expired: "Dokumen sudah melewati masa berlaku",
  not_applicable: "Item checklist disarankan tidak relevan",
};

// How the absence is framed depends on the status: a document that is entirely
// absent, one found only at low confidence, and one that has lapsed each carry
// a different consequence, and the report should not blur them.
const STATUS_FRAMING: Record<Exclude<DDGapStatus, "present">, string> = {
  missing: "Dokumen tersebut tidak ditemukan dalam Dokumen Yang Diperiksa.",
  incomplete:
    "Dokumen yang ditemukan belum dapat dipastikan lengkap, sehingga kesimpulan atas butir ini bersifat sementara.",
  expired:
    "Dokumen yang ditemukan telah melewati masa berlakunya, sehingga tidak lagi dapat diandalkan sebagai bukti pemenuhan kewajiban pada Tanggal Akhir Uji Tuntas.",
  not_applicable:
    "Butir ini disarankan tidak relevan bagi entitas atau transaksi ini dan belum dikonfirmasi oleh reviewer.",
};

const GENERIC_IMPACT: Record<DDSeverity, string> = {
  kritis:
    "Dokumen ini termasuk dokumen wajib; tanpa dokumen tersebut aspek ini tidak dapat dinilai dan pemenuhannya berpotensi menjadi syarat pendahuluan (condition precedent) penyelesaian transaksi.",
  material:
    "Kelengkapan aspek ini belum dapat dinilai secara penuh tanpa dokumen tersebut, sehingga terdapat risiko yang belum terukur.",
  minor:
    "Kelengkapan aspek ini belum dapat dinilai secara penuh tanpa dokumen tersebut.",
};

export function gapToFinding(gap: DDGapItem): DDFinding | null {
  if (gap.status === "present") return null;

  const severity: DDSeverity = gap.status === "not_applicable" ? "minor" : gap.severity;
  const rationale = gapRationaleFor(gap.expectedDocId);
  const framing = STATUS_FRAMING[gap.status];

  // whyItMatters carries the legal reasoning: why the law wants this specific
  // document, then what its absence means for this transaction.
  let whyItMatters: string;
  if (gap.status === "not_applicable") {
    whyItMatters = `${framing} Pengecualian suatu butir dari daftar permintaan dokumen memerlukan konfirmasi reviewer, karena butir yang dikecualikan tidak akan diuji lebih lanjut dalam Laporan ini.`;
  } else if (rationale) {
    whyItMatters = `${rationale.legalBasis} ${framing} ${rationale.absenceImpact}`;
  } else {
    whyItMatters = `${framing} ${GENERIC_IMPACT[severity]}`;
  }

  const suggestedFix =
    gap.status === "not_applicable"
      ? `Konfirmasikan kepada reviewer apakah "${gap.expectedLabel}" memang tidak relevan bagi entitas ini, dan catat alasannya dalam Laporan.`
      : (rationale?.remediation ??
        `Minta dokumen "${gap.expectedLabel}" dari target dan masukkan ke dalam daftar permintaan dokumen.`);

  return {
    id: `${gap.entityId}-kelengkapan-${gap.expectedDocId}`,
    entityId: gap.entityId,
    aspectId: gap.aspectId,
    dimension: "kelengkapan",
    severity,
    anchor: "",
    sourceFile: null,
    problem: `${STATUS_PROBLEM[gap.status]}: ${gap.expectedLabel}.${gap.note ? ` ${gap.note}` : ""}`.trim(),
    whyItMatters,
    suggestedFix,
    // Flows into the existing Perplexity currency check, so a citation that has
    // been superseded gets flagged rather than shipping unnoticed.
    regulationRefs: rationale?.legalRefs,
    verified: false,
    status: "open",
  };
}
