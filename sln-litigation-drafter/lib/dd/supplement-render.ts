import { formatIndonesianDate } from "@/lib/dd/report-boilerplate";
import { renderFindingsTable } from "@/lib/dd/findings-render";
import { DD_DEFAULT_REPORT_OPTIONS } from "@/types/dd";
import type { DDNarrativeBlock } from "@/lib/dd/narrative-render";
import type { DDReportOptions, DDSupplementDiff } from "@/types/dd";

/**
 * The body of a supplement, as blocks the docx builder already knows how to render.
 *
 * Pure: no `docx` import, so every sentence a client will read is unit-testable.
 *
 * The structure follows what a supplement is for. It reports the documents this
 * examination read and the earlier one did not, what those closed, what is still
 * outstanding, and what they raise — then accounts for the earlier report's findings
 * that a reader will not find in this one. Nothing here concludes that an earlier
 * finding is cured; the report says what the examination did and does not, and the
 * lawyer decides what that means.
 */

const NONE = "Tidak ada.";

function list(items: string[]): DDNarrativeBlock[] {
  if (items.length === 0) return [{ kind: "para", text: NONE }];
  return [{ kind: "list", items }];
}

export interface DDSupplementSection {
  title: string;
  blocks: DDNarrativeBlock[];
}

export function renderSupplementSections(
  diff: DDSupplementDiff,
  options: DDReportOptions = DD_DEFAULT_REPORT_OPTIONS
): DDSupplementSection[] {
  const before = diff.baselineCutoffDateISO
    ? formatIndonesianDate(diff.baselineCutoffDateISO)
    : "[TANGGAL AKHIR UJI TUNTAS LAPORAN SEBELUMNYA]";

  const sections: DDSupplementSection[] = [];

  sections.push({
    title: "Dokumen Tambahan Yang Diperiksa",
    blocks: [
      {
        kind: "para",
        text:
          diff.newDocuments.length === 0
            ? `Tidak terdapat dokumen yang belum tercakup dalam pemeriksaan sampai dengan ${before}.`
            : `Pemeriksaan dalam Laporan Tambahan ini mencakup ${diff.newDocuments.length} dokumen yang ` +
              `belum tercakup dalam pemeriksaan sampai dengan ${before}, dari keseluruhan ` +
              `${diff.documentsExaminedNow} dokumen yang kini diperiksa. Dokumen tersebut adalah:`,
      },
      ...(diff.newDocuments.length === 0 ? [] : list(diff.newDocuments)),
      // A document nobody could extract text from was NOT examined. Counting it
      // among the examined documents would claim an examination that did not
      // happen, so it is named instead.
      ...(diff.documentsUnreadable.length === 0
        ? []
        : ([
            {
              kind: "para",
              text:
                `Dokumen berikut tercantum dalam ruang data namun teksnya tidak dapat dibaca sehingga TIDAK ` +
                `dapat diperiksa. Dokumen tersebut tidak termasuk dalam dasar kesimpulan Laporan Tambahan ini ` +
                `dan wajib disediakan ulang dalam bentuk yang dapat dibaca:`,
            },
            { kind: "list", items: diff.documentsUnreadable },
          ] as DDNarrativeBlock[])),
    ],
  });

  sections.push({
    title: "Dokumen Yang Telah Dilengkapi",
    blocks: [
      {
        kind: "para",
        text:
          `Dokumen berikut, yang pada Laporan Sebelumnya dinyatakan belum tersedia atau belum lengkap, ` +
          `kini telah tersedia dan diperiksa:`,
      },
      ...list(diff.gapsClosed),
      // Kept separate on purpose: an item that left the list without being supplied
      // must never be reported as supplied, because that asserts receipt of a
      // document nobody has seen.
      ...(diff.gapsNoLongerListed.length === 0
        ? []
        : ([
            {
              kind: "para",
              text:
                `Dokumen berikut tidak lagi tercantum sebagai dokumen yang diminta, namun BUKAN karena telah ` +
                `diserahkan — melainkan karena dinyatakan tidak berlaku (not applicable) atau tidak lagi ` +
                `termasuk dalam checklist. Perubahan ini wajib ditelaah:`,
            },
            { kind: "list", items: diff.gapsNoLongerListed },
          ] as DDNarrativeBlock[])),
    ],
  });

  sections.push({
    title: "Dokumen Yang Masih Belum Tersedia",
    blocks: [
      {
        kind: "para",
        text: `Dokumen berikut telah diminta pada Laporan Sebelumnya dan sampai dengan Tanggal Akhir Uji Tuntas Laporan Tambahan ini masih belum tersedia atau belum lengkap:`,
      },
      ...list(diff.gapsStillOutstanding),
      ...(diff.gapsFirstListedNow.length === 0
        ? []
        : ([
            {
              kind: "para",
              // No causal claim: the baseline records no provenance for a checklist
              // item, so "revealed by the new documents" would be an inference.
              text:
                `Dokumen berikut tercatat sebagai belum tersedia untuk pertama kalinya pada pemeriksaan ini. ` +
                `Laporan Tambahan ini tidak menyatakan apa yang menyebabkannya tercatat — dapat karena ` +
                `dokumen yang baru diperiksa, dapat pula karena perubahan checklist atau ruang lingkup:`,
            },
            { kind: "list", items: diff.gapsFirstListedNow },
          ] as DDNarrativeBlock[])),
    ],
  });

  sections.push({
    title: "Temuan Yang Timbul Dari Dokumen Tambahan",
    blocks:
      diff.findingsFromNewDocuments.length === 0
        ? [
            {
              kind: "para",
              text: "Pemeriksaan atas dokumen tambahan tidak menghasilkan temuan baru.",
            },
          ]
        : renderFindingsTable(diff.findingsFromNewDocuments, options),
  });

  const accounted: DDNarrativeBlock[] = [];
  // "Unchanged" is only said of findings actually compared and found identical in
  // severity and wording. A persisting id cannot carry that claim: the identity is
  // deliberately blind to both, so that a reworded finding stays the same finding.
  accounted.push({
    kind: "para",
    text:
      `${diff.findingsCarriedForward} temuan dalam Laporan Sebelumnya tetap diangkat oleh pemeriksaan ini, ` +
      `${diff.findingsCarriedUnchanged} di antaranya tanpa perubahan tingkat maupun rumusan.`,
  });
  if (diff.findingsCarriedRevised.length > 0) {
    accounted.push({
      kind: "para",
      text:
        `Temuan berikut tetap diangkat namun tingkat atau rumusannya berubah dibandingkan Laporan ` +
        `Sebelumnya, sehingga rumusan dalam Laporan Tambahan inilah yang berlaku:`,
    });
    accounted.push({
      kind: "list",
      items: diff.findingsCarriedRevised.map((f) => f.problem),
    });
  }
  if (
    diff.findingsNoLongerRaised.length === 0 &&
    diff.findingsDismissedSinceBaseline.length === 0 &&
    diff.findingsCarriedRevised.length === 0
  ) {
    accounted.push({
      kind: "para",
      text: "Tidak terdapat temuan Laporan Sebelumnya yang dihapus, dikesampingkan, atau diubah.",
    });
  }
  if (diff.findingsNoLongerRaised.length > 0) {
    accounted.push({
      kind: "para",
      // Stated as a fact about the examination, not as a conclusion about the issue.
      // Only the lawyer can conclude that an earlier finding no longer stands.
      text:
        `Temuan berikut diangkat dalam Laporan Sebelumnya namun TIDAK dihasilkan oleh pemeriksaan atas ` +
        `dokumen sebagaimana tersedia pada Tanggal Akhir Uji Tuntas Laporan Tambahan ini. Hal ini BUKAN ` +
        `pernyataan bahwa temuan tersebut telah teratasi; penilaian atas hal itu memerlukan telaah advokat ` +
        `penanggung jawab:`,
    });
    accounted.push({
      kind: "list",
      items: diff.findingsNoLongerRaised.map((f) => f.problem),
    });
  }
  if (diff.findingsDismissedSinceBaseline.length > 0) {
    accounted.push({
      kind: "para",
      text:
        `Temuan berikut diangkat dalam Laporan Sebelumnya dan telah dikesampingkan berdasarkan telaah ` +
        `advokat penanggung jawab setelah Laporan Sebelumnya diterbitkan:`,
    });
    accounted.push({
      kind: "list",
      items: diff.findingsDismissedSinceBaseline.map((f) => f.problem),
    });
  }
  sections.push({ title: "Temuan Laporan Sebelumnya", blocks: accounted });

  return sections;
}
