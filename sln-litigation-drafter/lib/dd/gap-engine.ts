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
  return `${m[1]}-${m[2] ?? "12"}-${m[3] ?? "31"}`; // missing parts = latest possible
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
  missing: "Dokumen tidak ditemukan dalam data room",
  incomplete: "Dokumen kemungkinan tidak lengkap",
  expired: "Dokumen sudah melewati masa berlaku",
  not_applicable: "Item checklist disarankan tidak relevan",
};

export function gapToFinding(gap: DDGapItem): DDFinding | null {
  if (gap.status === "present") return null;
  return {
    id: `${gap.entityId}-kelengkapan-${gap.expectedDocId}`,
    entityId: gap.entityId,
    aspectId: gap.aspectId,
    dimension: "kelengkapan",
    severity: gap.status === "not_applicable" ? "minor" : gap.severity,
    anchor: "",
    sourceFile: null,
    problem: `${STATUS_PROBLEM[gap.status]}: ${gap.expectedLabel}. ${gap.note}`.trim(),
    whyItMatters:
      gap.severity === "kritis"
        ? "Dokumen wajib — ketiadaannya menghambat penilaian aspek ini dan berpotensi menjadi condition precedent."
        : "Kelengkapan aspek ini belum dapat dinilai penuh tanpa dokumen tersebut.",
    suggestedFix: `Minta dokumen "${gap.expectedLabel}" dari target / masukkan dalam daftar permintaan dokumen.`,
    verified: false,
    status: "open",
  };
}
