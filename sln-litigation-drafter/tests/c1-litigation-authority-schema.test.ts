import { describe, expect, it } from "vitest";
import { parseLitigationSessionAuthority } from "@/lib/litigation-session";

const sessionId = "11111111-1111-4111-8111-111111111111";
const validAuthority = () => ({
  version: 1,
  status: "active",
  sessionId,
  root: "https://sandiva.sharepoint.com/sites/Matters/Shared%20Documents/Alpha",
  driveId: "driveA",
  itemId: "rootA",
  createdAt: "2026-09-04T00:00:00.000Z",
});

const mandatoryStringFields = ["sessionId", "root", "driveId", "itemId", "createdAt"] as const;
const invalidRuntimeValues = [null, 123, true, [], {}, "", "   "] as const;

describe("C-1 persisted Litigation authority schema", () => {
  it("accepts one complete canonical authority record", () => {
    expect(parseLitigationSessionAuthority(validAuthority())).toEqual(validAuthority());
  });

  it.each(mandatoryStringFields)("rejects missing mandatory string field: %s", (field) => {
    const authority = validAuthority() as Record<string, unknown>;
    delete authority[field];
    expect(parseLitigationSessionAuthority(authority)).toBeNull();
  });

  it.each(mandatoryStringFields.flatMap((field) => invalidRuntimeValues.map((value) => [field, value] as const)))(
    "rejects %s with raw value %j before coercion", (field, value) => {
      const authority = validAuthority() as Record<string, unknown>;
      authority[field] = value;
      expect(parseLitigationSessionAuthority(authority)).toBeNull();
    },
  );

  it.each([
    ["sessionId", "not-a-session-id"],
    ["root", "drive:driveA:rootA"],
    ["driveId", "drive:bad"],
    ["itemId", "item:bad"],
    ["createdAt", "not-a-date"],
  ] as const)("rejects malformed identifier field: %s", (field, value) => {
    const authority = validAuthority() as Record<string, unknown>;
    authority[field] = value;
    expect(parseLitigationSessionAuthority(authority)).toBeNull();
  });

  it.each([
    undefined, null, 123, true, [], "authority", {},
  ])("rejects an unexpected top-level registry structure: %j", (value) => {
    expect(parseLitigationSessionAuthority(value)).toBeNull();
  });

  it.each([undefined, null, "1", 0, 2, true, [], {}])("rejects invalid version: %j", (value) => {
    const authority = validAuthority() as Record<string, unknown>;
    authority.version = value;
    expect(parseLitigationSessionAuthority(authority)).toBeNull();
  });

  it.each([undefined, null, "", " ", "expired", 1, true, [], {}])("rejects invalid status: %j", (value) => {
    const authority = validAuthority() as Record<string, unknown>;
    authority.status = value;
    expect(parseLitigationSessionAuthority(authority)).toBeNull();
  });

  it("rejects unexpected registry fields", () => {
    expect(parseLitigationSessionAuthority({ ...validAuthority(), legacyRoot: "Other" })).toBeNull();
  });
});
