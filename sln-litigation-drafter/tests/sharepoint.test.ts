import { describe, it, expect } from "vitest";
import { unwrapUrl } from "@/lib/sharepoint";

const BARE =
  "https://sandiva.sharepoint.com/:f:/s/50160SIG/IgDH-Lk5yRgiRq0jsMJLwv71AdTQyGVnfxl44yMmSrjHVyU?e=9QddKe";

describe("unwrapUrl", () => {
  it("leaves a bare URL unchanged", () => {
    expect(unwrapUrl(BARE)).toBe(BARE);
  });

  it("strips a leading/trailing parenthesis wrapper (markdown link body)", () => {
    expect(unwrapUrl(`(${BARE})`)).toBe(BARE);
  });

  it("extracts the URL out of a full markdown link", () => {
    expect(unwrapUrl(`[Data Room](${BARE})`)).toBe(BARE);
  });

  it("strips angle-bracket wrapping", () => {
    expect(unwrapUrl(`<${BARE}>`)).toBe(BARE);
  });

  it("extracts the URL from a prefixed label", () => {
    expect(unwrapUrl(`Link: ${BARE}`)).toBe(BARE);
  });

  it("trims surrounding whitespace around a bare URL", () => {
    expect(unwrapUrl(`  ${BARE}  `)).toBe(BARE);
  });

  it("leaves a genuine non-URL site-shorthand path untouched", () => {
    expect(unwrapUrl("5018BVI/Shared Documents/Folder")).toBe("5018BVI/Shared Documents/Folder");
  });
});
