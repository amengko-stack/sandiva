import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Every DD endpoint must have a caller.
 *
 * /api/dd/narrative had none. It is the only writer of ddKeys.narrative, so
 * load-results.ts always read back nothing, dd-docx-builder.ts's `if (r.narrative)`
 * was always false, and BAB II Profil Perseroan shipped as "tidak dapat disusun
 * karena dokumen korporasi belum diperiksa" on every report in the default format.
 * Roughly 43KB of working, tested code in narrative.ts and narrative-render.ts sat
 * behind one missing fetch, and nothing failed — no test, no type error, no runtime
 * error. The report simply came out short a chapter.
 *
 * A unit test cannot see this: every piece worked. Only the absence of a call site
 * was wrong, so that is what this asserts.
 */

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, "app", "api", "dd");

/** Endpoints with no UI caller by design. */
const NO_UI_CALLER: Record<string, string> = {
  // Operator-facing: reports which env vars are configured, so that a missing
  // PERPLEXITY_API_KEY — which degrades silently by design — can be seen. Someone
  // opens it directly; no stage should call it.
  health: "operator diagnostic, opened directly rather than from a stage",
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

/** "app/api/dd/extract-table/route.ts" -> "extract-table" */
const endpoints = walk(API_DIR)
  .filter((f) => path.basename(f) === "route.ts")
  .map((f) => path.relative(API_DIR, path.dirname(f)).split(path.sep).join("/"))
  .sort();

/** Everything that could hold a fetch: the app pages and every component. */
const callerSource = [path.join(ROOT, "app"), path.join(ROOT, "components"), path.join(ROOT, "lib")]
  .flatMap(walk)
  .filter((f) => /\.tsx?$/.test(f))
  // A route referring to its own path is not a caller.
  .filter((f) => !f.startsWith(path.join(ROOT, "app", "api")))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

describe("every DD endpoint has a caller", () => {
  it("found the routes to check", () => {
    expect(endpoints.length).toBeGreaterThan(10);
    expect(endpoints).toContain("narrative");
  });

  for (const ep of endpoints) {
    const reason = NO_UI_CALLER[ep];
    const label = reason ? `${ep} is deliberately uncalled (${reason})` : `${ep} is called from the app`;

    it(label, () => {
      const called = callerSource.includes(`/api/dd/${ep}`);
      if (reason) {
        expect(called).toBe(false);
      } else {
        expect(called).toBe(true);
      }
    });
  }
});
