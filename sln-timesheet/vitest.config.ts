import { defineConfig } from "vitest/config";

export default defineConfig({
  // Stop Vite walking up to the monorepo root's postcss.config.js.
  css: { postcss: { plugins: [] } },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
