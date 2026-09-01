import { describe, expect, it } from "vitest";
import { analyzeTransactionChapters } from "@/lib/dd/redflag";
import * as analysisState from "@/lib/dd/analysis-state";

type TransactionDigest = (
  subsections: string[],
  docsText: string,
  failedDocs: string[]
) => string;

function captureTransactionRequest(failedDocs?: string[]) {
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
      failedDocs: failedDocs ?? [],
    }
  ).then(() => {
    if (!request) throw new Error("Transaction request was not captured");
    return request;
  });
}

describe("transaction chapters know which supplied documents failed extraction", () => {
  it("names failed documents and forbids treating those documents as absent", async () => {
    const request = await captureTransactionRequest(["Akta Perubahan.pdf", "Scan_001.pdf"]);
    const prompt = request.messages[0].content;

    expect(prompt).toContain("Akta Perubahan.pdf");
    expect(prompt).toContain("Scan_001.pdf");
    expect(prompt).toContain("DOKUMEN ITU ADA");
    expect(prompt).toContain("JANGAN menyatakan dokumen tersebut tidak diserahkan");
    expect(prompt).toContain("nama file generik");
    expect(prompt).toContain("[PERLU VERIFIKASI]");
  });

  it("keeps genuine-absence analysis available and adds no raw extraction error", async () => {
    const request = await captureTransactionRequest(["Akta Perubahan.pdf"]);
    const prompt = request.messages[0].content;

    expect(request.system).toContain("Nyatakan secara tegas apa yang BELUM ada");
    expect(prompt).toContain("dokumen lain");
    expect(prompt).not.toContain("GraphError tenant=secret-internal-detail");
  });

  it("preserves the prior prompt when there are no failed documents", async () => {
    const [omitted, empty] = await Promise.all([
      captureTransactionRequest(),
      captureTransactionRequest([]),
    ]);

    expect(empty.messages[0].content).toBe(omitted.messages[0].content);
    expect(empty.messages[0].content).not.toContain("DOKUMEN ITU ADA");
  });
});

describe("transaction analysis cache context", () => {
  it("changes when failed documents are added, removed, or renamed", () => {
    const transactionSeenDigest = (
      analysisState as typeof analysisState & { transactionSeenDigest?: TransactionDigest }
    ).transactionSeenDigest;

    expect(typeof transactionSeenDigest).toBe("function");
    if (!transactionSeenDigest) return;

    const none = transactionSeenDigest(["Sub A", "Sub B"], "isi readable", []);
    const aktaA = transactionSeenDigest(["Sub A", "Sub B"], "isi readable", ["Akta A.pdf"]);
    const aktaB = transactionSeenDigest(["Sub A", "Sub B"], "isi readable", ["Akta B.pdf"]);

    expect(none).toBe("680ce8d209264bac89bde874148d2368");
    expect(aktaA).not.toBe(none);
    expect(aktaB).not.toBe(none);
    expect(aktaA).not.toBe(aktaB);
  });

  it("preserves the historical digest when the failed list is empty", () => {
    const transactionSeenDigest = (
      analysisState as typeof analysisState & { transactionSeenDigest?: TransactionDigest }
    ).transactionSeenDigest;

    expect(typeof transactionSeenDigest).toBe("function");
    if (!transactionSeenDigest) return;

    expect(transactionSeenDigest(["Sub A", "Sub B"], "isi readable", []))
      .toBe("680ce8d209264bac89bde874148d2368");
  });
});
