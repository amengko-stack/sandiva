import { describe, it, expect } from "vitest";
import { rematchTailored, parseTailorResponse } from "@/lib/dd/tailor";
import type { DDClassifiedDoc, DDExpectedDoc } from "@/types/dd";

const doc = (over: Partial<DDClassifiedDoc>): DDClassifiedDoc => ({
  fileName: "f.pdf", entityId: "e1", aspectId: "perizinan", expectedDocId: null,
  docLabel: "doc", docDate: null, parties: [], summary: "", confidence: "tinggi",
  reasoning: "", ...over,
});

const addedDoc = (over: Partial<DDExpectedDoc>): DDExpectedDoc => ({
  id: "perizinan.iup", aspectId: "perizinan", label: "IUP Operasi Produksi",
  importance: "wajib", keywords: ["iup"], source: "ai_tailored", ...over,
});

describe("rematchTailored", () => {
  it("rematches a null-expectedDocId doc whose docLabel contains an added doc's keyword (same aspectId)", () => {
    const classified = [doc({ aspectId: "perizinan", expectedDocId: null, docLabel: "IUP Operasi Produksi 2023" })];
    const result = rematchTailored(classified, [addedDoc({})]);
    expect(result[0].expectedDocId).toBe("perizinan.iup");
  });

  it("does not rematch across aspects even when a keyword matches", () => {
    const classified = [doc({ aspectId: "harta_kekayaan", expectedDocId: null, docLabel: "IUP Operasi Produksi 2023" })];
    const result = rematchTailored(classified, [addedDoc({ aspectId: "perizinan" })]);
    expect(result[0].expectedDocId).toBeNull();
  });

  it("leaves docs with an existing expectedDocId untouched", () => {
    const classified = [doc({ aspectId: "perizinan", expectedDocId: "perizinan.nib", docLabel: "IUP Operasi Produksi 2023" })];
    const result = rematchTailored(classified, [addedDoc({})]);
    expect(result[0].expectedDocId).toBe("perizinan.nib");
  });

  it("stays null when no added doc's keywords match", () => {
    const classified = [doc({ aspectId: "perizinan", expectedDocId: null, docLabel: "Sertifikat Tanah" })];
    const result = rematchTailored(classified, [addedDoc({})]);
    expect(result[0].expectedDocId).toBeNull();
  });
});

describe("parseTailorResponse", () => {
  it("parses a valid payload", () => {
    const raw = JSON.stringify({
      added: [{ id: "perizinan.iup", aspectId: "perizinan", label: "IUP", importance: "wajib", keywords: ["iup"] }],
      notApplicableSuggestions: [{ expectedDocId: "asuransi.polis", reason: "tidak relevan untuk entitas ini" }],
    });
    const result = parseTailorResponse(raw, null);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].id).toBe("perizinan.iup");
    expect(result.added[0].aspectId).toBe("perizinan");
    expect(result.notApplicableSuggestions).toHaveLength(1);
    expect(result.notApplicableSuggestions[0].expectedDocId).toBe("asuransi.polis");
  });

  it("throws on garbage", () => {
    expect(() => parseTailorResponse("bukan json sama sekali", null)).toThrow();
  });
});
