import { describe, it, expect, beforeEach } from "vitest";
import { queryPerplexity } from "@/lib/dd/perplexity";
import { collectRegulationRefs, checkCurrency, applyCurrency } from "@/lib/dd/currency";
import type { DDFinding } from "@/types/dd";

const finding = (over: Partial<DDFinding>): DDFinding => ({
  id: "f1", entityId: "e1", aspectId: "perizinan", dimension: "risiko", severity: "minor",
  anchor: "", sourceFile: null, problem: "", whyItMatters: "", suggestedFix: "",
  verified: false, status: "open", ...over,
});

const okFetch = (content: string): typeof fetch =>
  (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch;

describe("queryPerplexity", () => {
  it("returns message content", async () => {
    const out = await queryPerplexity("tes", "key", okFetch("jawaban"));
    expect(out).toBe("jawaban");
  });
  it("throws without an api key", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    await expect(queryPerplexity("tes", undefined, okFetch("x"))).rejects.toThrow(/PERPLEXITY_API_KEY/);
  });
});

describe("collectRegulationRefs", () => {
  it("dedupes across findings", () => {
    const refs = collectRegulationRefs([
      finding({ regulationRefs: ["UU 40/2007", "UU 13/2003"] }),
      finding({ id: "f2", regulationRefs: ["UU 13/2003"] }),
      finding({ id: "f3" }),
    ]);
    expect(refs).toEqual(["UU 13/2003", "UU 40/2007"]);
  });
});

describe("checkCurrency", () => {
  // The queryPerplexity test above deletes the env key — restore it here, or
  // checkCurrency soft-fails to "unknown" and the assertions below break.
  beforeEach(() => { process.env.PERPLEXITY_API_KEY = "test-key"; });

  it("parses per-ref verdicts from the model's JSON", async () => {
    const payload = JSON.stringify({
      results: [
        { ref: "UU 13/2003", status: "superseded", note: "Diubah oleh UU 6/2023 (Cipta Kerja)." },
        { ref: "UU 40/2007", status: "current", note: "Masih berlaku." },
      ],
    });
    const map = await checkCurrency(["UU 13/2003", "UU 40/2007"], okFetch(payload));
    expect(map["UU 13/2003"].status).toBe("superseded");
    expect(map["UU 40/2007"].status).toBe("current");
  });

  it("soft-fails to unknown on any error", async () => {
    const badFetch = (async () => new Response("gateway error", { status: 502 })) as unknown as typeof fetch;
    process.env.PERPLEXITY_API_KEY = "key";
    const map = await checkCurrency(["UU 13/2003"], badFetch);
    expect(map["UU 13/2003"].status).toBe("unknown");
  });

  it("returns empty map for no refs without calling the API", async () => {
    const map = await checkCurrency([], (() => { throw new Error("must not be called"); }) as unknown as typeof fetch);
    expect(map).toEqual({});
  });
});

describe("applyCurrency", () => {
  it("marks superseded findings and floors severity at material", () => {
    const out = applyCurrency(
      [finding({ regulationRefs: ["UU 13/2003"], severity: "minor" })],
      { "UU 13/2003": { status: "superseded", note: "Diubah oleh UU 6/2023." } }
    );
    expect(out[0].currencyStatus).toBe("superseded");
    expect(out[0].severity).toBe("material");
    expect(out[0].currencyNote).toContain("UU 6/2023");
  });
  it("leaves findings without refs untouched", () => {
    const out = applyCurrency([finding({})], {});
    expect(out[0].currencyStatus).toBeUndefined();
  });
});
