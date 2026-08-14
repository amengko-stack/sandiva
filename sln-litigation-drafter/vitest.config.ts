import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Vitest defaults to 5s, which suits ordinary unit tests. Several tests here
    // build whole Word documents — one builds four, one per report format — and as
    // the suite grew past 450 tests running in parallel workers, those started
    // exceeding it. The symptom was three tests failing intermittently in a full run
    // and passing in isolation, which reads like a real defect and cost time to
    // dismiss twice before being diagnosed. They were never failing an assertion;
    // they were being cut off mid-render.
    //
    // 20s is generous enough that machine load cannot cause it and short enough to
    // still catch a genuine hang.
    testTimeout: 20_000,
  },
});
