import { describe, expect, it } from "vitest";
import { analyzeTransactionChapters } from "@/lib/dd/redflag";
import * as analysisState from "@/lib/dd/analysis-state";

type TransactionDigest = (
  docsText: string,
  unreadableDocs: string[],
  failedDocs: string[]
) => string;

function captureTransactionRequest(args: {
  unreadableDocs?: string[];
  failedDocs?: string[];
} = {}) {
  let request: { system: string; messages: { content: string }[] } | undefined;
  const client = {
    messages: {
      create: async (input: { system: string; messages: { content: string }[] }) => {
        request = input;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              analyses: [{
                subsectionTitle: "Persetujuan Transaksi",
                analysis: ["Analisis berdasarkan dokumen yang dapat dibaca."],
                verification: [],
              }],
            }),
          }],
          stop_reason: "end_turn",
        };
      },
    },
  };

  return analyzeTransactionChapters(
    client as unknown as Parameters<typeof analyzeTransactionChapters>[0],
    {
      entityId: "e1",
      entityName: "PT Target",
      docsText: "=== RUPS.pdf ===\nIsi keputusan RUPS",
      transactionType: "akuisisi_saham",
      regime: { layers: ["uupt"], capitalMarkets: false, parentTbkName: null },
      subsections: ["Persetujuan Transaksi"],
      unreadableDocs: args.unreadableDocs ?? [],
      failedDocs: args.failedDocs ?? [],
    }
  ).then(() => {
    if (!request) throw new Error("Transaction request was not captured");
    return request;
  });
}

describe("transaction chapters know which supplied documents could not be read", () => {
  it("names OCR-required documents and forbids treating those documents as absent", async () => {
    const request = await captureTransactionRequest({
      unreadableDocs: ["Akta Pendirian Scan.pdf"],
    });
    const prompt = request.messages[0].content;

    expect(prompt).toContain("Akta Pendirian Scan.pdf");
    expect(prompt).toContain("DOKUMEN ITU ADA");
    expect(prompt).toContain("memerlukan OCR");
    expect(prompt).toContain("verifikasi manual");
    expect(prompt).toContain("JANGAN menyatakan dokumen tersebut tidak diserahkan");
  });

  it("names failed documents and forbids treating those documents as absent", async () => {
    const request = await captureTransactionRequest({
      failedDocs: ["Akta Perubahan.pdf", "Scan_001.pdf"],
    });
    const prompt = request.messages[0].content;

    expect(prompt).toContain("Akta Perubahan.pdf");
    expect(prompt).toContain("Scan_001.pdf");
    expect(prompt).toContain("DOKUMEN ITU ADA");
    expect(prompt).toContain("JANGAN menyatakan dokumen tersebut tidak diserahkan");
    expect(prompt).toContain("nama file generik");
    expect(prompt).toContain("[PERLU VERIFIKASI]");
  });

  it("keeps OCR-required and failed-extraction documents operationally distinct", async () => {
    const request = await captureTransactionRequest({
      unreadableDocs: ["Akta Pendirian Scan.pdf"],
      failedDocs: ["Akta Perubahan.pdf"],
    });
    const prompt = request.messages[0].content;

    expect(prompt).toContain("Akta Pendirian Scan.pdf");
    expect(prompt).toContain("memerlukan OCR");
    expect(prompt).toContain("Akta Perubahan.pdf");
    expect(prompt).toContain("gagal diekstrak");
  });

  it("does not use a generic OCR filename as proof that a specific document is absent", async () => {
    const request = await captureTransactionRequest({ unreadableDocs: ["Scan_001.pdf"] });
    const prompt = request.messages[0].content;

    expect(prompt).toContain("Scan_001.pdf");
    expect(prompt).toContain("nama file generik");
    expect(prompt).toContain("jangan menebak jenis atau isinya");
    expect(prompt).toContain("jangan gunakan ketidakjelasan tersebut sebagai bukti");
  });

  it("keeps genuine-absence analysis available and adds no raw extraction error", async () => {
    const request = await captureTransactionRequest({ failedDocs: ["Akta Perubahan.pdf"] });
    const prompt = request.messages[0].content;

    expect(request.system).toContain("Nyatakan secara tegas apa yang BELUM ada");
    expect(prompt).toContain("dokumen lain");
    expect(prompt).not.toContain("GraphError tenant=secret-internal-detail");
  });

  it("preserves the prior prompt when no supplied document is unreadable", async () => {
    const [omitted, empty] = await Promise.all([
      captureTransactionRequest(),
      captureTransactionRequest({ unreadableDocs: [], failedDocs: [] }),
    ]);

    expect(empty.messages[0].content).toBe(omitted.messages[0].content);
    expect(empty.messages[0].content).not.toContain("DOKUMEN ITU ADA");
  });
});

describe("transaction analysis cache context", () => {
  it("changes for each supplied-unreadable category and filename", () => {
    const transactionSeenDigest = (
      analysisState as typeof analysisState & { transactionSeenDigest?: TransactionDigest }
    ).transactionSeenDigest;

    expect(typeof transactionSeenDigest).toBe("function");
    if (!transactionSeenDigest) return;

    const none = transactionSeenDigest("isi readable", [], []);
    const scanA = transactionSeenDigest("isi readable", ["Scan A.pdf"], []);
    const scanB = transactionSeenDigest("isi readable", ["Scan B.pdf"], []);
    const failedA = transactionSeenDigest("isi readable", [], ["Failed A.pdf"]);
    const both = transactionSeenDigest("isi readable", ["Scan A.pdf"], ["Failed A.pdf"]);

    expect(new Set([none, scanA, scanB, failedA, both])).toHaveLength(5);
  });

  it("is stable for unchanged H-3 effective document input", () => {
    const transactionSeenDigest = (
      analysisState as typeof analysisState & { transactionSeenDigest?: TransactionDigest }
    ).transactionSeenDigest;

    expect(typeof transactionSeenDigest).toBe("function");
    if (!transactionSeenDigest) return;

    expect(transactionSeenDigest("isi readable", [], []))
      .toBe(transactionSeenDigest("isi readable", [], []));
  });
});
