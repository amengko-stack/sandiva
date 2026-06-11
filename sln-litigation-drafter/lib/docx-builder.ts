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

export async function buildLitigationDocx(
  text: string,
  meta: DocxMeta
): Promise<Buffer> {
  const clean = sanitizeForXml(text);
  if (clean.length !== text.length) {
    console.warn(`[docx-builder] stripped ${text.length - clean.length} XML-invalid control chars from draft`);
  }
  const children = buildChildren(clean);

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Arial", size: 22 } },
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          run: { size: 24, bold: true, font: "Arial", color: "1F3864" },
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
          run: { size: 22, bold: true, font: "Arial", color: "2E5090" },
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
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1800 },
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
                    font: "Arial",
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
                    font: "Arial",
                    color: "888888",
                  }),
                  new TextRun({ text: "\t", size: 16 }),
                  new TextRun({
                    text: "Halaman ",
                    size: 16,
                    font: "Arial",
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
                    font: "Arial",
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
      /^(I{1,3}V?|VI{0,3}|IX|X{1,2})\.\s+\S/.test(line) ||
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
              size: 24,
              font: "Arial",
              color: "1F3864",
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
            new TextRun({ text: line, bold: true, size: 22, font: "Arial" }),
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
              font: "Arial",
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
          spacing: { before: 40, after: 40 },
          indent: { left: 720, hanging: 360 },
          children: [
            new TextRun({
              text: "•  " + line.replace(/^[-•]\s+/, ""),
              font: "Arial",
              size: 22,
            }),
          ],
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
              font: "Arial",
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
        spacing: { before: 60, after: 80, line: 288 },
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
        new TextRun({ text: text.slice(last, m.index), font: "Arial", size: 22 })
      );
    }
    if (m[1]) {
      runs.push(
        new TextRun({ text: m[1], bold: true, font: "Arial", size: 22 })
      );
    } else if (m[2]) {
      runs.push(
        new TextRun({ text: m[2], italics: true, font: "Arial", size: 22 })
      );
    }
    last = regex.lastIndex;
  }
  if (last < text.length) {
    runs.push(
      new TextRun({ text: text.slice(last), font: "Arial", size: 22 })
    );
  }
  return runs.length
    ? runs
    : [new TextRun({ text, font: "Arial", size: 22 })];
}
