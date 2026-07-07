import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  Header,
  Footer,
  PageNumber,
  TabStopType,
  TabStopPosition,
  LevelFormat,
  LineRuleType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  VerticalAlign,
} from "docx";
import { getClaimTypeLabel } from "@/config/documentTypes";

interface DocxMeta {
  ref: string;
  docType: string;
  claimType: string;
}

// The docx library writes text verbatim into document.xml WITHOUT escaping
// control characters — a single \x0B or \x07 in the draft (LLM output can
// contain them) produces not-well-formed XML that Word rejects as "corrupt",
// both for the downloaded file and the SharePoint copy. Strip everything
// XML 1.0 forbids; keep \t \n \r.
function sanitizeForXml(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// ─── Section-group header patterns (displayed as bold divider rows in Daftar Isi)
const SECTION_GROUP_RE = /^(DALAM EKSEPSI|DALAM POKOK PERKARA|DALAM REKONVENSI|PETITUM|PERMOHONAN)(\b.*)?$/;
// ─── Individual sub-heading patterns: roman numerals or capital-letter sections
// Roman pattern covers I–XXXIX ((?=[IVX]) forbids the empty match) — the old
// alternation missed XI–XVIII, so sections 11+ lost their heading style.
const ROMAN = "(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})";
const HEADING_ITEM_RE = new RegExp(`^((?:${ROMAN})\\.\\s+\\S|[A-Z]\\.\\s+\\S)`);
const HEADING_COUNTER_RE = new RegExp(`^((?:${ROMAN})|[A-Z])\\.`);
const HEADING_STRIP_RE = new RegExp(`^(?:(?:${ROMAN})|[A-Z])\\.\\s+`);
const H1_ROMAN_RE = new RegExp(`^(?:${ROMAN})\\.\\s+\\S`);

interface TocEntry {
  kind: "group" | "item";
  label: string;
  counter?: string; // roman/letter number for items
}

function extractTocEntries(text: string): TocEntry[] {
  const entries: TocEntry[] = [];
  let itemSeq = 0;
  let currentGroup: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    const groupMatch = SECTION_GROUP_RE.exec(line.trim());
    if (groupMatch) {
      currentGroup = line.trim();
      entries.push({ kind: "group", label: currentGroup });
      itemSeq = 0;
      continue;
    }

    if (currentGroup && HEADING_ITEM_RE.test(line)) {
      itemSeq++;
      const numMatch = HEADING_COUNTER_RE.exec(line);
      const counter = numMatch ? numMatch[1] + "." : String(itemSeq) + ".";
      const title = line.replace(HEADING_STRIP_RE, "").trim();
      entries.push({ kind: "item", label: title, counter });
    }
  }
  return entries;
}

const CELL_BORDER = {
  top:    { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
  left:   { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
  right:  { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
};

function tocCell(
  text: string,
  opts: {
    bold?: boolean;
    italic?: boolean;
    colSpan?: number;
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
    shaded?: boolean;
    width?: number;
  } = {}
): TableCell {
  const { bold, italic, colSpan, align, shaded, width = 1000 } = opts;
  return new TableCell({
    columnSpan: colSpan,
    width: { size: width, type: WidthType.DXA },
    shading: shaded
      ? { type: ShadingType.CLEAR, color: "auto", fill: "E8E8E8" }
      : { type: ShadingType.CLEAR, color: "auto", fill: "FFFFFF" },
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    borders: CELL_BORDER,
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        alignment: align ?? AlignmentType.LEFT,
        children: [
          new TextRun({ text, bold, italics: italic, font: "Calibri Light", size: 20 }),
        ],
      }),
    ],
  });
}

function buildDaftarIsiTable(entries: TocEntry[]): (Table | Paragraph)[] {
  // Header row
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      tocCell("NO.",    { bold: true, align: AlignmentType.CENTER, shaded: true, width: 600 }),
      tocCell("URAIAN", { bold: true, align: AlignmentType.CENTER, shaded: true, width: 6200 }),
      tocCell("HAL.",   { bold: true, align: AlignmentType.CENTER, shaded: true, width: 800 }),
    ],
  });

  const dataRows: TableRow[] = entries.map((e) => {
    if (e.kind === "group") {
      return new TableRow({
        children: [
          tocCell(e.label, { bold: true, colSpan: 3, shaded: true, width: 7600 }),
        ],
      });
    }
    return new TableRow({
      children: [
        tocCell(e.counter ?? "",  { align: AlignmentType.CENTER, width: 600 }),
        tocCell(e.label,          { width: 6200 }),
        tocCell("",               { align: AlignmentType.CENTER, width: 800 }),
      ],
    });
  });

  const table = new Table({
    width: { size: 7600, type: WidthType.DXA },
    borders: {
      top:              { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
      bottom:           { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
      left:             { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
      right:            { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
      insideVertical:   { style: BorderStyle.SINGLE, size: 4, color: "AAAAAA" },
    },
    rows: [headerRow, ...dataRows],
  });

  const note = new Paragraph({
    spacing: { before: 80, after: 240 },
    children: [
      new TextRun({
        text: "Nomor halaman agar diisi manual setelah dokumen final.",
        italics: true,
        font: "Calibri Light",
        size: 18,
        color: "888888",
      }),
    ],
  });

  return [table, note];
}

// Document types for which Daftar Isi is relevant
const TOC_DOC_TYPES = /jawaban|gugatan|kesimpulan/i;
const TOC_MIN_ENTRIES = 3;

export async function buildLitigationDocx(
  text: string,
  meta: DocxMeta,
  appendix?: string
): Promise<Buffer> {
  const clean = sanitizeForXml(text);
  if (clean.length !== text.length) {
    console.warn(`[docx-builder] stripped ${text.length - clean.length} XML-invalid control chars from draft`);
  }

  // Build Daftar Isi block before splitting children, so we can splice it in
  // at the right position (after the kepala surat block, before the first H1 section).
  let tocBlock: (Table | Paragraph)[] = [];
  if (TOC_DOC_TYPES.test(meta.docType)) {
    const tocEntries = extractTocEntries(clean);
    if (tocEntries.length >= TOC_MIN_ENTRIES) {
      tocBlock = buildDaftarIsiTable(tocEntries);
    }
  }

  // Find line index of first H1 in the source text so we can split children.
  // buildChildren processes lines in the same order, so paragraph count up to
  // that line matches the paragraph index to splice at.
  let spliceAt = -1;
  if (tocBlock.length > 0) {
    const lines = clean.split("\n");
    let paraCount = 0;
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (
        H1_ROMAN_RE.test(line) ||
        /^(DALAM EKSEPSI|DALAM POKOK PERKARA|DALAM REKONVENSI|PETITUM|PERMOHONAN)/.test(line.trim())
      ) {
        spliceAt = paraCount;
        break;
      }
      paraCount++;
    }
  }

  const bodyParagraphs: (Paragraph | Table)[] = buildChildren(clean);
  if (tocBlock.length > 0) {
    const insertAt = spliceAt >= 0 ? spliceAt : 0;
    bodyParagraphs.splice(insertAt, 0, ...tocBlock);
  }
  const children = bodyParagraphs;

  // Append internal citation checklist on a new page when provided
  if (appendix) {
    const cleanAppendix = sanitizeForXml(appendix);
    children.push(
      new Paragraph({
        pageBreakBefore: true,
        spacing: { before: 0, after: 120 },
        children: [
          new TextRun({
            text: "LAMPIRAN INTERNAL — DAFTAR SITASI UNTUK VERIFIKASI — JANGAN DISERTAKAN DALAM BERKAS YANG DIFILING",
            bold: true,
            color: "C0392B",
            font: "Calibri Light",
            size: 20,
          }),
        ],
      })
    );
    buildChildren(cleanAppendix).forEach((p) => children.push(p));
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: "sln-bullet",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "-",
              alignment: AlignmentType.LEFT,
              style: {
                run: { font: "Calibri Light", size: 22 },
                paragraph: { indent: { left: 720, hanging: 360 } },
              },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: { run: { font: "Calibri Light", size: 22 } },
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          run: { size: 22, bold: true, font: "Calibri Light" },
          paragraph: {
            spacing: { before: 360, after: 120 },
            outlineLevel: 0,
          },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          run: { size: 22, bold: true, font: "Calibri Light" },
          paragraph: {
            spacing: { before: 240, after: 80 },
            outlineLevel: 1,
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                border: {
                  bottom: {
                    style: BorderStyle.SINGLE,
                    size: 6,
                    color: "1F3864",
                  },
                },
                spacing: { after: 100 },
                children: [
                  new TextRun({
                    text: `SANDIVA LEGAL NETWORK  |  ${meta.docType.toUpperCase()} — ${getClaimTypeLabel(meta.claimType).toUpperCase()}  |  RAHASIA`,
                    size: 16,
                    font: "Calibri Light",
                    color: "888888",
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                border: {
                  top: {
                    style: BorderStyle.SINGLE,
                    size: 6,
                    color: "1F3864",
                  },
                },
                spacing: { before: 80 },
                tabStops: [
                  {
                    type: TabStopType.RIGHT,
                    position: TabStopPosition.MAX,
                  },
                ],
                children: [
                  new TextRun({
                    text: `Ref: ${meta.ref}`,
                    size: 16,
                    font: "Calibri Light",
                    color: "888888",
                  }),
                  new TextRun({ text: "\t", size: 16 }),
                  new TextRun({
                    text: "Halaman ",
                    size: 16,
                    font: "Calibri Light",
                    color: "888888",
                  }),
                  // Page number must be run content: PageNumber.CURRENT inside
                  // a TextRun emits a PAGE field within <w:r>. The previous
                  // PageNumberElement as a direct Paragraph child emitted
                  // <w:pgNum/> directly under <w:p> — schema-invalid OOXML
                  // that made Word reject every generated file as corrupt.
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 16,
                    font: "Calibri Light",
                    color: "888888",
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

function buildChildren(text: string): Paragraph[] {
  const children: Paragraph[] = [];
  const lines = text.split("\n");

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
      continue;
    }

    if (
      H1_ROMAN_RE.test(line) ||
      /^(DALAM EKSEPSI|DALAM POKOK PERKARA|DALAM REKONVENSI|PETITUM|PERMOHONAN)/.test(
        line.trim()
      )
    ) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 120 },
          children: [
            new TextRun({
              text: line,
              bold: true,
              size: 22,
              font: "Calibri Light",
            }),
          ],
        })
      );
      continue;
    }

    if (/^[A-Z]\.\s+\S/.test(line)) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 80 },
          children: [
            new TextRun({ text: line, bold: true, size: 22, font: "Calibri Light" }),
          ],
        })
      );
      continue;
    }

    if (
      /^(Kepada Yth|Dengan hormat|Yang bertanda tangan|SURAT GUGATAN|JAWABAN|REPLIK|DUPLIK|KESIMPULAN|PERMOHONAN PKPU|PERMOHONAN PAILIT)/.test(
        line.trim()
      )
    ) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 60 },
          children: [
            new TextRun({
              text: line.trim(),
              bold: line.trim().toUpperCase() === line.trim(),
              font: "Calibri Light",
              size: 22,
            }),
          ],
        })
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      children.push(
        new Paragraph({
          spacing: { before: 60, after: 60 },
          indent: { left: 720, hanging: 480 },
          children: parseInline(line),
        })
      );
      continue;
    }

    if (/^[-•]\s+/.test(line)) {
      children.push(
        new Paragraph({
          numbering: { reference: "sln-bullet", level: 0 },
          spacing: { before: 40, after: 40 },
          children: parseInline(line.replace(/^[-•]\s+/, "")),
        })
      );
      continue;
    }

    if (/^\[Opsi [AB]\]/i.test(line)) {
      children.push(
        new Paragraph({
          spacing: { before: 100, after: 40 },
          children: [
            new TextRun({
              text: line,
              bold: true,
              italics: true,
              color: "1A5276",
              font: "Calibri Light",
              size: 20,
            }),
          ],
        })
      );
      continue;
    }

    children.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        spacing: { before: 60, after: 80, line: 276, lineRule: LineRuleType.AUTO },
        children: parseInline(line),
      })
    );
  }

  return children;
}

function parseInline(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) {
      runs.push(
        new TextRun({ text: text.slice(last, m.index), font: "Calibri Light", size: 22 })
      );
    }
    if (m[1]) {
      runs.push(
        new TextRun({ text: m[1], bold: true, font: "Calibri Light", size: 22 })
      );
    } else if (m[2]) {
      runs.push(
        new TextRun({ text: m[2], italics: true, font: "Calibri Light", size: 22 })
      );
    }
    last = regex.lastIndex;
  }
  if (last < text.length) {
    runs.push(
      new TextRun({ text: text.slice(last), font: "Calibri Light", size: 22 })
    );
  }
  return runs.length
    ? runs
    : [new TextRun({ text, font: "Calibri Light", size: 22 })];
}
