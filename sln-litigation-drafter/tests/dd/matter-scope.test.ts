import { describe, it, expect } from "vitest";
import {
  isWithinMatter,
  matterRoots,
  normalizeFolderRef,
  refuseIfOutsideMatter,
} from "@/lib/matter-scope";
import type { DDTransaction } from "@/types/dd";

const ALPHA = "https://sandiva.sharepoint.com/sites/5018BVI/Shared Documents/Alpha";
const BETA = "https://sandiva.sharepoint.com/sites/9001XYZ/Shared Documents/Beta";

const txn = (paths: string[]) =>
  ({
    entities: paths.map((p, i) => ({ id: `e${i + 1}`, name: `PT ${i}`, role: "target", dataRoomPath: p, files: [] })),
  }) as unknown as DDTransaction;

describe("a matter reaches only the folders it registered", () => {
  it("admits the registered root itself", () => {
    expect(isWithinMatter(ALPHA, [ALPHA])).toBe(true);
  });

  it("admits a folder beneath the root", () => {
    expect(isWithinMatter(`${ALPHA}/Korporasi/AD`, [ALPHA])).toBe(true);
  });

  // The whole point: this is the ethical wall.
  it("refuses another matter's site", () => {
    expect(isWithinMatter(BETA, [ALPHA])).toBe(false);
  });

  // Without a separator in the prefix test, "Alpha" would admit "Alpha-Holdings",
  // which is a different client.
  it("refuses a sibling whose name merely starts the same way", () => {
    expect(isWithinMatter(`${ALPHA}-Holdings/Docs`, [ALPHA])).toBe(false);
    expect(isWithinMatter(`${ALPHA}Extra`, [ALPHA])).toBe(false);
  });

  it("refuses traversal back out of a root it would otherwise match", () => {
    expect(isWithinMatter(`${ALPHA}/../Beta`, [ALPHA])).toBe(false);
  });

  it("refuses an empty or missing request", () => {
    expect(isWithinMatter("", [ALPHA])).toBe(false);
    expect(isWithinMatter("   ", [ALPHA])).toBe(false);
  });

  // A multi-entity DD legitimately has one data room per company.
  it("admits every entity's own data room", () => {
    const roots = [ALPHA, BETA];
    expect(isWithinMatter(`${ALPHA}/x`, roots)).toBe(true);
    expect(isWithinMatter(`${BETA}/y`, roots)).toBe(true);
  });
});

describe("normalisation, which must never widen what matches", () => {
  it("ignores trailing slashes, case and backslashes", () => {
    expect(normalizeFolderRef(`${ALPHA}/`)).toBe(normalizeFolderRef(ALPHA));
    expect(normalizeFolderRef(ALPHA.toUpperCase())).toBe(normalizeFolderRef(ALPHA));
    expect(isWithinMatter(`${ALPHA}\\Korporasi`, [ALPHA])).toBe(true);
  });

  it("unwraps the angle brackets Outlook adds to a pasted link", () => {
    expect(isWithinMatter(`<${ALPHA}/Korporasi>`, [ALPHA])).toBe(true);
  });

  it("matches a percent-encoded path against its decoded root", () => {
    expect(isWithinMatter(`${ALPHA}/Shared%20Docs`, [ALPHA])).toBe(true);
  });

  it("survives a malformed escape without throwing", () => {
    expect(() => normalizeFolderRef("%E0%A4%A")).not.toThrow();
    expect(isWithinMatter("%E0%A4%A", [ALPHA])).toBe(false);
  });
});

describe("the route guard", () => {
  it("passes a folder inside the matter", () => {
    expect(refuseIfOutsideMatter(`${ALPHA}/Korporasi`, txn([ALPHA]))).toBeNull();
  });

  it("refuses another matter, and says why", () => {
    const msg = refuseIfOutsideMatter(BETA, txn([ALPHA]));
    expect(msg).toContain("bukan bagian dari matter ini");
  });

  // Fail closed: a matter with nothing recorded reaches nothing, rather than
  // falling back to "anything goes".
  it("refuses everything when the matter recorded no data room", () => {
    expect(refuseIfOutsideMatter(ALPHA, txn([]))).toContain("belum memiliki folder");
    expect(refuseIfOutsideMatter(ALPHA, txn(["", "  "]))).toContain("belum memiliki folder");
  });

  it("collects the roots a matter registered, skipping blanks", () => {
    expect(matterRoots(txn([ALPHA, "", BETA]))).toEqual([ALPHA, BETA]);
  });
});
