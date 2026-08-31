#!/usr/bin/env node
/**
 * PostToolUse hook — run only the tests that cover the file just edited.
 *
 * `vitest related` maps a source file to the test files that import it, so a
 * change to lib/dd/statute.ts runs tests/dd/statute.test.ts (36 tests, ~0.3s)
 * rather than the full 541-test suite. That is what makes this affordable on
 * every single edit.
 *
 * Do not "simplify" this to `npm test`. Several tests build whole Word
 * documents and the suite carries a 20s per-test timeout for that reason
 * (see vitest.config.ts); running all of it on each keystroke-sized edit would
 * make the hook the slowest thing in the session.
 *
 * Exits 2 on failure, which is the code that feeds stderr back to Claude.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const APP = "sln-litigation-drafter";

const stdin = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => resolve(buf));
});

let filePath;
try {
  filePath = JSON.parse(stdin)?.tool_input?.file_path;
} catch {
  process.exit(0); // A payload we cannot read is not the edit's problem.
}
if (typeof filePath !== "string" || filePath === "") process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const appDir = path.join(root, APP);
const rel = path.relative(appDir, filePath).split(path.sep).join("/");

// Only source files inside the Next app. The legacy root app has no tests at
// all, and `vitest related` expects sources rather than test files.
//
// The character class is deliberately strict rather than `.+`. `&`, `;`, `$`,
// backtick and parens are all legal in Windows filenames, so a permissive
// pattern would let a filename carry a shell payload. We no longer invoke a
// shell (see below), which is the real fix — this is the second lock.
if (rel.startsWith("..")) process.exit(0);
if (!/^(lib|app|components|config)\/[A-Za-z0-9_./-]+\.tsx?$/.test(rel)) process.exit(0);
if (/\.test\.tsx?$/.test(rel)) process.exit(0);
if (!existsSync(filePath)) process.exit(0);

// Run vitest's JS entry point directly under this same node binary.
//
// The obvious `npx vitest ...` needs `shell: true` on Windows, because npx is
// a .cmd and node refuses to spawn one otherwise (CVE-2024-27980). But
// shell: true flattens argv into a command string for cmd.exe, which would
// make `rel` injectable. Calling vitest.mjs with shell: false keeps every
// argument a true argv element, so metacharacters are inert.
const vitestBin = path.join(appDir, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitestBin)) process.exit(0); // deps not installed — not a test failure

const res = spawnSync(
  process.execPath,
  [vitestBin, "related", "--run", "--passWithNoTests", "--reporter=dot", rel],
  { cwd: appDir, encoding: "utf8", shell: false },
);

// An explicit status check, not execFileSync's throw-on-error: a non-zero exit
// did not reliably surface as an exception here, so a failing suite was once
// silently reported as a pass.
if (res.error) process.exit(0); // could not run it at all — not a test failure
if (res.status === 0) process.exit(0);

const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
// Tail rather than head: vitest puts the failure summary at the end.
console.error(`Tests covering ${rel} are failing:\n\n${output.slice(-4000)}`);
process.exit(2);
