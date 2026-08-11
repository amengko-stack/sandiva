import { describe, it, expect } from "vitest";
import { DD_ENV_REQUIREMENTS, ddHealth } from "@/lib/dd/health";

// The branch landed in production with the environment unverified, and the failure
// that mattered was the silent one: without a Perplexity key the currency check
// soft-fails to "unknown" for every reference, so Stage 5 completes and the report
// goes out with an empty currency column while nothing anywhere says why.

const full = {
  ANTHROPIC_API_KEY: "a",
  BLOB_READ_WRITE_TOKEN: "b",
  PERPLEXITY_API_KEY: "c",
  CRON_SECRET: "d",
};

describe("ddHealth", () => {
  it("reports a fully configured deployment as ready and undegraded", () => {
    const h = ddHealth(full);
    expect(h.ready).toBe(true);
    expect(h.degraded).toEqual([]);
    expect(h.blocking).toEqual([]);
    expect(h.env).toHaveLength(DD_ENV_REQUIREMENTS.length);
  });

  it("separates what blocks the workflow from what silently degrades it", () => {
    const h = ddHealth({ BLOB_READ_WRITE_TOKEN: "b", CRON_SECRET: "d" });
    expect(h.ready).toBe(false);
    expect(h.blocking).toEqual(["ANTHROPIC_API_KEY"]);
    expect(h.degraded).toEqual(["PERPLEXITY_API_KEY"]);
  });

  // The whole point: a missing Perplexity key still leaves the workflow "ready",
  // because it genuinely does run. It has to be reported as degradation instead.
  it("still reports ready without the Perplexity key, and names the consequence", () => {
    const h = ddHealth({ ...full, PERPLEXITY_API_KEY: undefined });
    expect(h.ready).toBe(true);
    expect(h.degraded).toEqual(["PERPLEXITY_API_KEY"]);
    const row = h.env.find((e) => e.name === "PERPLEXITY_API_KEY");
    expect(row?.consequence).toContain("TIDAK error");
    expect(row?.consequence).toContain("kolom keberlakuan kosong");
  });

  // Vercel makes it easy to save a variable with an empty value, which reads as
  // configured everywhere except where it is used.
  it("treats an empty or whitespace value as not configured", () => {
    expect(ddHealth({ ...full, ANTHROPIC_API_KEY: "" }).blocking).toEqual(["ANTHROPIC_API_KEY"]);
    expect(ddHealth({ ...full, ANTHROPIC_API_KEY: "   " }).blocking).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("reports the retention period actually in force", () => {
    expect(ddHealth(full).retentionDays).toBe(90);
    expect(ddHealth({ ...full, DD_SESSION_RETENTION_DAYS: "30" }).retentionDays).toBe(30);
    // A nonsense value falls back to the default rather than shortening retention.
    expect(ddHealth({ ...full, DD_SESSION_RETENTION_DAYS: "abc" }).retentionDays).toBe(90);
  });

  // Presence only. A health endpoint that leaked a key would be a far worse bug
  // than the one it was built to catch.
  it("never carries a value, only whether one is set", () => {
    const serialised = JSON.stringify(ddHealth({ ...full, ANTHROPIC_API_KEY: "sk-rahasia-sekali" }));
    expect(serialised).not.toContain("sk-rahasia-sekali");
    for (const row of ddHealth(full).env) {
      expect(typeof row.present).toBe("boolean");
    }
  });

  it("names the missing cron secret as a retention problem, not a broken feature", () => {
    const row = ddHealth({}).env.find((e) => e.name === "CRON_SECRET");
    expect(row?.required).toBe(false);
    expect(row?.consequence).toContain("tidak pernah dihapus");
  });
});
