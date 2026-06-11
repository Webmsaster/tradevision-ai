import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    globals: true,
    css: true,
    include: ["scripts/**/*.test.ts"],
    fileParallelism: false,
    pool: "forks",
    // 2026-05-21 bug-round: `poolOptions` was REMOVED in Vitest 4 (silently
    // ignored + deprecation warning), so the intended `singleFork: true` never
    // took effect. Per the v4 migration guide, forks.singleFork → top-level
    // `maxWorkers: 1`. (fileParallelism:false already forces 1 worker, so this
    // is consistent — stateful paper-trade scripts stay serialized.)
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
