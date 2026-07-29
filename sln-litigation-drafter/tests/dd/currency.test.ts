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

describe("checkCurrency batching", () => {
  beforeEach(() => { process.env.PERPLEXITY_API_KEY = "test-key"; });

  // Regression: a single call for many refs made sonar answer "unknown" for
  // nearly all of them (measured 1/46 real verdicts). Refs must be split into
  // batches of <=10 so each call researches a small set.
  it("splits many refs into batches of 10 and merges every verdict", async () => {
    const refs = Array.from({ length: 23 }, (_, i) => `UU ${i + 1}/2020`);
    const seenBatches: string[][] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const asked = String(body.messages[0].content)
        .split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
      seenBatches.push(asked);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            results: asked.map((ref) => ({ ref, status: "superseded", note: "diganti" })),
          }) } }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const map = await checkCurrency(refs, fetchImpl);

    expect(seenBatches).toHaveLength(3);                    // 10 + 10 + 3
    expect(seenBatches.every((b) => b.length <= 10)).toBe(true);
    expect(Object.keys(map)).toHaveLength(23);
    expect(Object.values(map).every((v) => v.status === "superseded")).toBe(true);
  });

  it("keeps one failing batch from poisoning the others", async () => {
    const refs = Array.from({ length: 20 }, (_, i) => `UU ${i + 1}/2020`);
    let call = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const asked = String(JSON.parse(String(init.body)).messages[0].content)
        .split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
      if (call++ === 0) return new Response("boom", { status: 502 });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            results: asked.map((ref) => ({ ref, status: "current", note: "berlaku" })),
          }) } }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const map = await checkCurrency(refs, fetchImpl);
    const statuses = Object.values(map).map((v) => v.status);
    expect(statuses.filter((s) => s === "unknown")).toHaveLength(10); // failed batch only
    expect(statuses.filter((s) => s === "current")).toHaveLength(10);
  });
});
