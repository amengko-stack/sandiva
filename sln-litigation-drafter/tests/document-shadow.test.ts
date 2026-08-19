import { describe, expect, it, vi } from "vitest";
import {
  compareShadowOutputs,
  createShadowObserver,
  isShadowEligible,
  type ShadowEvent,
} from "@/lib/document-shadow";
import { createMarkItDownConverter } from "@/lib/markitdown-shadow";

describe("AI-02 document shadow policy", () => {
  it.each([
    ["agreement.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["notes.txt", "text/plain"],
  ])("admits only the approved extension and matching MIME for %s", (fileName, mimeType) => {
    expect(isShadowEligible({ fileName, mimeType, sizeBytes: 1024 })).toBe(true);
  });

  it.each([
    ["scan.pdf", "application/pdf"],
    ["agreement.docx", "application/pdf"],
    ["notes.txt", "text/html"],
    ["legacy.doc", "application/msword"],
    ["book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ])("rejects unsupported or MIME-mismatched input %s", (fileName, mimeType) => {
    expect(isShadowEligible({ fileName, mimeType, sizeBytes: 1024 })).toBe(false);
  });

  it("rejects sources larger than the 25 MiB stage-one limit", () => {
    expect(isShadowEligible({
      fileName: "agreement.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 25 * 1024 * 1024 + 1,
    })).toBe(false);
  });
});

describe("AI-02 privacy-safe comparison", () => {
  it("measures content without retaining source text or high-risk literals", () => {
    const comparison = compareShadowOutputs(
      "PT Contoh membayar Rp1.250.000 pada 19 Agustus 2026.",
      "# PT Contoh\n\nMembayar Rp1.250.000 pada 19 Agustus 2026.",
      "tenant-scoped-test-key",
    );

    expect(comparison.primaryCharacters).toBe(52);
    expect(comparison.shadowCharacters).toBe(55);
    expect(comparison.highRiskLiteralRecall).toBe(1);
    expect(JSON.stringify(comparison)).not.toContain("PT Contoh");
    expect(JSON.stringify(comparison)).not.toContain("1.250.000");
  });
});

describe("AI-02 shadow observer isolation", () => {
  it("returns immediately, uses the supplied immutable bytes, and emits bounded telemetry", async () => {
    let release!: () => void;
    const conversionDone = new Promise<void>((resolve) => { release = resolve; });
    const sourceBytes = Buffer.from("source bytes");
    const events: ShadowEvent[] = [];
    const convert = vi.fn(async (bytes: Buffer) => {
      expect(bytes).toBe(sourceBytes);
      await conversionDone;
      return "shadow markdown";
    });
    const observer = createShadowObserver({
      enabled: true,
      sampleRate: 1,
      random: () => 0,
      convert,
      emit: (event) => events.push(event),
      tenantSalt: "test-only-salt",
    });

    const pending = observer.observe({
      sourceBytes,
      fileName: "Rahasia PT Contoh.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sourceRevision: "2026-08-19T08:00:00Z",
      tenantId: "tenant-a",
      matterId: "matter-secret",
      documentId: "document-secret",
      primaryText: "primary legal text",
    });

    await Promise.resolve();
    expect(convert).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      "shadow_eligible",
      "shadow_sampled",
      "shadow_started",
    ]);
    expect(JSON.stringify(events)).not.toContain("Rahasia");
    expect(JSON.stringify(events)).not.toContain("matter-secret");
    expect(JSON.stringify(events)).not.toContain("primary legal text");

    release();
    await pending;
    expect(events.at(-1)?.type).toBe("comparison_completed");
  });

  it("fails open and records an allowlisted error code without exception text", async () => {
    const events: ShadowEvent[] = [];
    const observer = createShadowObserver({
      enabled: true,
      sampleRate: 1,
      random: () => 0,
      convert: async () => { throw new Error("secret filename and document text"); },
      emit: (event) => events.push(event),
      tenantSalt: "test-only-salt",
    });

    await expect(observer.observe({
      sourceBytes: Buffer.from("source"),
      fileName: "notes.txt",
      mimeType: "text/plain",
      sourceRevision: "rev-1",
      tenantId: "tenant-a",
      matterId: "matter-a",
      documentId: "document-a",
      primaryText: "primary",
    })).resolves.toBeUndefined();

    expect(events.at(-1)).toMatchObject({ type: "shadow_failed", errorCode: "converter_error" });
    expect(JSON.stringify(events)).not.toContain("secret filename");
  });
});

describe("MarkItDown worker boundary", () => {
  it("passes only bytes and an allowlisted file class to the isolated worker", async () => {
    const run = vi.fn(async (bytes: Buffer, fileClass: "docx" | "txt") => {
      expect(bytes.equals(Buffer.from("document bytes"))).toBe(true);
      expect(fileClass).toBe("docx");
      return "# Converted";
    });
    const convert = createMarkItDownConverter({ run });

    await expect(convert(Buffer.from("document bytes"), "docx")).resolves.toBe("# Converted");
    expect(run).toHaveBeenCalledOnce();
  });
});
