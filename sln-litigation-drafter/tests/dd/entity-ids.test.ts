import { describe, it, expect } from "vitest";
import { slugifyEntityName, uniqueEntityIds } from "@/lib/dd/entity-ids";
import { isValidEntityId } from "@/lib/dd/blob-keys";

describe("slugifyEntityName", () => {
  it("lowercases, replaces non-alphanumerics with hyphens, and trims", () => {
    expect(slugifyEntityName("PT Alpha Sentosa")).toBe("pt-alpha-sentosa");
  });

  it("falls back to 'entitas' for empty or symbol-only names", () => {
    expect(slugifyEntityName("")).toBe("entitas");
    expect(slugifyEntityName("!!!___***")).toBe("entitas");
  });

  it("always produces a slug matching the valid entity id pattern", () => {
    const tricky = [
      "PT Sangat Panjang Nama Perusahaan Yang Melebihi Batas",
      "---leading and trailing---",
      "  spaces  everywhere  ",
      "Ünïcödé Nämé",
      "123-456-789",
    ];
    for (const name of tricky) {
      const slug = slugifyEntityName(name);
      expect(slug).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    }
  });
});

describe("uniqueEntityIds", () => {
  it("de-dupes identical names deterministically with numeric suffixes", () => {
    expect(uniqueEntityIds(["PT Alpha", "PT Alpha", "PT Alpha"])).toEqual([
      "pt-alpha",
      "pt-alpha-2",
      "pt-alpha-3",
    ]);
  });

  it("leaves distinct names untouched", () => {
    expect(uniqueEntityIds(["PT Alpha", "PT Beta"])).toEqual(["pt-alpha", "pt-beta"]);
  });

  it("produces ids that all satisfy isValidEntityId, even for long collisions", () => {
    const longName = "A".repeat(30);
    const ids = uniqueEntityIds([longName, longName]);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      expect(isValidEntityId(id)).toBe(true);
    }
  });

  it("accepts every generated id via isValidEntityId for a mixed batch", () => {
    const names = ["PT Alpha", "PT Alpha", "PT Beta", "!!!", "!!!", longNameGen()];
    const ids = uniqueEntityIds(names);
    for (const id of ids) {
      expect(isValidEntityId(id)).toBe(true);
    }
  });
});

function longNameGen() {
  return "B".repeat(40);
}
