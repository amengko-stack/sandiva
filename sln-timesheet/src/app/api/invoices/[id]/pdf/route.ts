import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { db, tables } from "@/db";
import { jsonError, requireSession } from "@/lib/api";
import { getFirmProfile, fmtMoney } from "@/lib/billing/firm";

export const maxDuration = 30;

const NAVY = "#003D5A";
const BURGUNDY = "#792C38";
const PURPLE = "#522B4C";
const GREY = "#41535d";
const LIGHT = "#6a7a84";
const LINE = "#dbe3e8";

// Branded invoice PDF — reproduces the firm's real Statement_invoice.pdf:
// gradient band, firm block + wordmark, bill-to grid, Attorney's Fees table,
// SUBTOTAL, Cost section, PPN totals box, bank block, engagement-partner
// signature. This PDF is the ONLY detailed client-facing invoice (Accurate
// holds just the summary).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireSession(["partner", "admin"]);
  if (!auth.ok) return auth.response;

  const id = Number(params.id);
  const invoice = await db().query.invoices.findFirst({ where: eq(tables.invoices.id, id) });
  if (!invoice) return jsonError("Invoice not found.", 404);
  const lines = await db()
    .select()
    .from(tables.invoiceLines)
    .where(eq(tables.invoiceLines.invoiceId, id))
    .orderBy(asc(tables.invoiceLines.date), asc(tables.invoiceLines.id));
  const firm = await getFirmProfile();

  const cb = invoice.clientBlock as any;
  const sig = invoice.signatory as any;
  const cur = invoice.currency as "IDR" | "USD";
  const fees = (lines as any[]).filter((l) => l.kind === "fee");
  const disb = (lines as any[]).filter((l) => l.kind === "disbursement");
  const m = (n: number) => fmtMoney(n, cur);

  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - 80; // content width
  const L = 40;

  // --- header band (navy -> burgundy -> purple) ---
  const bandW = W + 80;
  for (let i = 0; i < 60; i++) {
    const t = i / 59;
    const color = t < 0.6 ? blend(NAVY, BURGUNDY, t / 0.6) : blend(BURGUNDY, PURPLE, (t - 0.6) / 0.4);
    doc.rect((bandW / 60) * i, 0, bandW / 60 + 1, 26).fill(color);
  }
  doc.fillColor("white").font("Helvetica-Bold").fontSize(10).text("I N V O I C E", L, 8, { characterSpacing: 4 });

  // --- firm block + wordmark ---
  doc.fillColor("#101f28").font("Helvetica-Bold").fontSize(8).text(firm.addressLines[0], L, 38);
  doc.fillColor(GREY).font("Helvetica").fontSize(7.5);
  firm.addressLines.slice(1).forEach((line) => doc.text(line));
  doc.text(`NPWP : ${firm.npwp}`);
  doc.text(`Email : ${firm.email}   Phone : ${firm.phone}`);

  doc.font("Helvetica-Bold").fontSize(17).fillColor(NAVY)
    .text("S A N D I V A", L, 40, { width: W, align: "right", characterSpacing: 3 });

  // --- bill-to / meta grid ---
  let y = 108;
  doc.font("Helvetica").fontSize(8.5);
  const kv = (x: number, yy: number, k: string, v: string, kw = 62, vw = 180) => {
    doc.fillColor(LIGHT).text(k, x, yy, { width: kw });
    doc.fillColor("#101f28").text(v ?? "", x + kw, yy, { width: vw });
    return Math.max(doc.heightOfString(v ?? "", { width: vw }), 10);
  };
  doc.font("Helvetica-Bold").fillColor("#101f28").text("Bill to", L, y, { underline: true });
  y += 14;
  doc.font("Helvetica");
  let yl = y;
  yl += kv(L, yl, "Customer", cb.name, 62, 190) + 2;
  if (cb.address) yl += kv(L, yl, "Address", cb.address, 62, 190) + 2;
  if (cb.up) yl += kv(L, yl, "UP", cb.up, 62, 190) + 2;
  let yr = y;
  const RX = L + 285;
  yr += kv(RX, yr, "Invoice Date", invoice.invoiceDate, 84, 140) + 2;
  yr += kv(RX, yr, "Due", invoice.dueDate, 84, 140) + 2;
  yr += kv(RX, yr, "Invoice Number", invoice.accurateInvoiceNo, 84, 140) + 2;
  yr += kv(RX, yr, "Client / Project", `${cb.clientCode} / ${cb.matterCode}`, 84, 140) + 2;
  y = Math.max(yl, yr) + 8;

  doc.font("Helvetica-Bold").fontSize(9).fillColor("#101f28")
    .text(`Matter : ${cb.matterTitle}`, L, y, { width: W, align: "right" });
  y += 16;

  // --- section banner ---
  const banner = (label: string) => {
    for (let i = 0; i < 40; i++) {
      const t = i / 39;
      doc.rect(L + (W / 40) * i, y, W / 40 + 1, 14).fill(blend(NAVY, "#3a2230", t));
    }
    doc.fillColor("white").font("Helvetica-Bold").fontSize(7.5)
      .text(label.toUpperCase(), L, y + 4, { width: W - 8, align: "right", characterSpacing: 2 });
    y += 20;
  };

  banner("Attorney's Fees");

  // --- fees table ---
  const cols = [52, 170, 78, 78, 36, 80]; // date, desc, lawyer, rate, units, amount
  const colX = cols.reduce<number[]>((acc, w, i) => [...acc, (acc[i] ?? L) + (i ? cols[i - 1] : 0)], []).slice(0, 6);
  const headers = ["Date", "Service Description", "Lawyer", "Rate / Unit", "Units", "Amount"];
  const rightCols = new Set([3, 4, 5]);

  const tableHeader = () => {
    doc.rect(L, y, W, 14).fill("#f3f6f8");
    doc.fillColor(GREY).font("Helvetica-Bold").fontSize(7);
    headers.forEach((h, i) =>
      doc.text(h.toUpperCase(), colX[i] + 3, y + 4, { width: cols[i] - 6, align: rightCols.has(i) ? "right" : "left" }),
    );
    doc.rect(L, y, W, 14).stroke(LINE);
    y += 14;
  };
  tableHeader();

  doc.font("Helvetica").fontSize(7.8);
  let feeUnits = 0;
  let feeAmt = 0;
  const combined = new Set(fees.map((l: any) => l.matterCode).filter(Boolean)).size > 1;
  let currentMatter: string | null = null;
  for (const l of fees) {
    // Combined invoice: a matter sub-header row before each group.
    if (combined && l.matterCode && l.matterCode !== currentMatter) {
      currentMatter = l.matterCode;
      if (y + 13 > doc.page.height - 60) {
        doc.addPage();
        y = 40;
        tableHeader();
        doc.font("Helvetica").fontSize(7.8);
      }
      doc.rect(L, y, W, 13).fillAndStroke("#eef2f5", LINE);
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(7.5).text(`Matter ${l.matterCode}`, L + 4, y + 3.5);
      doc.font("Helvetica").fontSize(7.8);
      y += 13;
    }
    const cells = [
      l.date,
      l.description,
      l.lawyerName ?? "",
      l.rate ? m(Number(l.rate)) : "—",
      Number(l.units).toFixed(2),
      m(Number(l.amount)),
    ];
    const h = Math.max(
      ...cells.map((c, i) => doc.heightOfString(String(c), { width: cols[i] - 6 })),
      10,
    ) + 6;
    if (y + h > doc.page.height - 60) {
      doc.addPage();
      y = 40;
      tableHeader();
      doc.font("Helvetica").fontSize(7.8);
    }
    cells.forEach((c, i) => {
      doc.rect(colX[i], y, cols[i], h).stroke(LINE);
      doc.fillColor("#1c2b33").text(String(c), colX[i] + 3, y + 3, { width: cols[i] - 6, align: rightCols.has(i) ? "right" : "left" });
    });
    y += h;
    feeUnits += Number(l.units);
    feeAmt += Number(l.amount);
  }
  // subtotal row
  doc.rect(L, y, W, 14).fillAndStroke("#fafcfd", LINE);
  doc.fillColor("#101f28").font("Helvetica-Bold").fontSize(8);
  doc.text("SUBTOTAL", colX[2], y + 4, { width: cols[2] - 6 });
  doc.text(feeUnits.toFixed(2), colX[4] + 3, y + 4, { width: cols[4] - 6, align: "right" });
  doc.text(m(feeAmt), colX[5] + 3, y + 4, { width: cols[5] - 6, align: "right" });
  y += 22;

  banner("Cost");
  doc.font("Helvetica").fontSize(7.8);
  if (disb.length) {
    for (const l of disb) {
      const h = Math.max(doc.heightOfString(l.description, { width: W - 150 }), 10) + 6;
      doc.rect(L, y, 60, h).stroke(LINE);
      doc.rect(L + 60, y, W - 140, h).stroke(LINE);
      doc.rect(L + W - 80, y, 80, h).stroke(LINE);
      doc.fillColor("#1c2b33");
      doc.text(l.date, L + 3, y + 3, { width: 54 });
      doc.text(l.description, L + 63, y + 3, { width: W - 146 });
      doc.text(m(Number(l.amount)), L + W - 77, y + 3, { width: 74, align: "right" });
      y += h;
    }
  } else {
    doc.rect(L, y, W, 14).stroke(LINE);
    doc.fillColor("#8a97a0").text("No disbursements recorded for this period.", L + 3, y + 4);
    y += 14;
  }
  y += 14;

  // --- totals box ---
  if (y > doc.page.height - 170) {
    doc.addPage();
    y = 40;
  }
  const TX = L + W - 220;
  const totalRow = (label: string, value: string, grand = false) => {
    doc.rect(TX, y, 220, 16);
    if (grand) doc.fillAndStroke(NAVY, NAVY);
    else doc.stroke(LINE);
    doc.fillColor(grand ? "white" : "#101f28").font(grand ? "Helvetica-Bold" : "Helvetica").fontSize(8.5);
    doc.text(label, TX + 6, y + 4, { width: 120 });
    doc.text(value, TX + 6, y + 4, { width: 208, align: "right" });
    y += 16;
  };
  totalRow("Subtotal", m(Number(invoice.subtotal)));
  totalRow(`VAT (PPN ${Number(invoice.ppnRate)}%)`, m(Number(invoice.ppnAmount)));
  totalRow("Total", m(Number(invoice.total)), true);
  y += 18;

  // --- bank + signature ---
  const bankY = y;
  doc.fillColor("#101f28").font("Helvetica-Bold").fontSize(8).text("Please remit the payment to", L, y, { underline: true });
  doc.font("Helvetica").fontSize(7.8).fillColor(GREY);
  doc.text(`Account Name : ${firm.bank.accountName}`, L, y + 12);
  doc.text(`Account Number : ${firm.bank.accountNo}`);
  doc.text(`Bank : ${firm.bank.bankName}`);
  doc.text(`Swift Code : ${firm.bank.swift}`);

  doc.fillColor("#101f28").font("Helvetica").fontSize(8.5).text("Sincerely,", L + W - 170, bankY, { width: 170, align: "center" });
  doc.moveTo(L + W - 150, bankY + 52).lineTo(L + W - 20, bankY + 52).stroke("#101f28");
  doc.font("Helvetica-Bold").text(sig.name, L + W - 170, bankY + 55, { width: 170, align: "center" });
  doc.font("Helvetica").fontSize(7.5).fillColor(LIGHT).text(sig.title ?? "Partner", L + W - 170, bankY + 67, { width: 170, align: "center" });

  if (invoice.status === "void") {
    doc.fontSize(60).fillColor("#792c3833").font("Helvetica-Bold")
      .text("VOID", L, doc.page.height / 2 - 40, { width: W, align: "center" });
  }

  doc.end();
  const pdf = await done;

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${invoice.accurateInvoiceNo.replace(/[^\w.-]+/g, "_")}.pdf"`,
    },
  });
}

/** Linear blend of two hex colors. */
function blend(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.min(Math.max(t, 0), 1)));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
