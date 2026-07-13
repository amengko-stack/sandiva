import { describe, it, expect } from "vitest";
import { parseClassifyResponse, buildClassifyPrompt } from "@/lib/dd/classify";
import { SEED_CHECKLIST } from "@/config/ddChecklist.seed";

const args = { fileName: "NIB.pdf", entityId: "e1", expected: SEED_CHECKLIST.base };

describe("parseClassifyResponse", () => {
  it("parses a valid response and preserves known ids", () => {
    const raw = JSON.stringify({
      aspectId: "perizinan", expectedDocId: "perizinan.nib", docLabel: "NIB PT Alpha",
      docDate: "2023-05-01", parties: ["PT Alpha"], summary: "NIB perusahaan.",
      confidence: "tinggi", reasoning: "Judul dokumen NIB.",
    });
    const doc = parseClassifyResponse(raw, null, args);
    expect(doc.fileName).toBe("NIB.pdf");
    expect(doc.entityId).toBe("e1");
    expect(doc.aspectId).toBe("perizinan");
    expect(doc.expectedDocId).toBe("perizinan.nib");
  });

  it("nulls an expectedDocId not in the checklist and falls back on unknown aspect", () => {
    const raw = JSON.stringify({
      aspectId: "not_an_aspect", expectedDocId: "made.up", docLabel: "X",
      docDate: null, parties: [], summary: "", confidence: "sedang", reasoning: "",
    });
    const doc = parseClassifyResponse(raw, null, args);
    expect(doc.expectedDocId).toBeNull();
    expect(doc.aspectId).toBe("perjanjian_penting"); // safe default bucket
  });

  it("repairs max_tokens truncation", () => {
    const truncated = '{"aspectId":"perizinan","expectedDocId":null,"docLabel":"Izin usaha","docDate":null,"parties":["PT A"';
    const doc = parseClassifyResponse(truncated, "max_tokens", args);
    expect(doc.aspectId).toBe("perizinan");
  });

  it("throws on garbage", () => {
    expect(() => parseClassifyResponse("bukan json", null, args)).toThrow();
  });
});

describe("buildClassifyPrompt", () => {
  it("lists checklist ids and includes the document content", () => {
    const p = buildClassifyPrompt({
      fileName: "NIB.pdf", content: "ISI DOKUMEN NIB", entityName: "PT Alpha",
      transactionType: "akuisisi_saham", expected: SEED_CHECKLIST.base,
    });
    expect(p).toContain("perizinan.nib");
    expect(p).toContain("ISI DOKUMEN NIB");
    expect(p).toContain("PT Alpha");
  });
});
