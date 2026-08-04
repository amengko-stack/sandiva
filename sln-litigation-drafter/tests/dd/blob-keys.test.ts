import { describe, it, expect } from "vitest";
import { ddKeys, isValidEntityId } from "@/lib/dd/blob-keys";

describe("ddKeys", () => {
  it("nests everything under sessions/<sid>/dd/", () => {
    expect(ddKeys.transaction("abc12345")).toBe("sessions/abc12345/dd/transaction.json");
    expect(ddKeys.extracted("abc12345", "pt-alpha")).toBe(
      "sessions/abc12345/dd/entities/pt-alpha/extracted_text.json"
    );
    expect(ddKeys.report("abc12345", "pt-alpha")).toBe("sessions/abc12345/dd/entities/pt-alpha/report.json");
    expect(ddKeys.classified("abc12345", "pt-alpha")).toBe("sessions/abc12345/dd/entities/pt-alpha/classified.json");
    expect(ddKeys.tailored("abc12345", "pt-alpha")).toBe("sessions/abc12345/dd/entities/pt-alpha/tailored.json");
    expect(ddKeys.gaps("abc12345", "pt-alpha")).toBe("sessions/abc12345/dd/entities/pt-alpha/gaps.json");
    expect(ddKeys.tables("abc12345", "pt-alpha")).toBe("sessions/abc12345/dd/entities/pt-alpha/tables.json");
    expect(ddKeys.findings("abc12345", "pt-alpha")).toBe("sessions/abc12345/dd/entities/pt-alpha/findings.json");
    expect(ddKeys.consolidated("abc12345")).toBe("sessions/abc12345/dd/consolidated.json");
  });
});

describe("isValidEntityId", () => {
  it("accepts short slugs", () => {
    expect(isValidEntityId("pt-alpha")).toBe(true);
    expect(isValidEntityId("e1")).toBe(true);
  });
  it("rejects traversal, slashes, empties, non-strings", () => {
    expect(isValidEntityId("../x")).toBe(false);
    expect(isValidEntityId("a/b")).toBe(false);
    expect(isValidEntityId("")).toBe(false);
    expect(isValidEntityId(null)).toBe(false);
    expect(isValidEntityId("x".repeat(33))).toBe(false);
  });
});
