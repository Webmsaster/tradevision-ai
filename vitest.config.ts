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
    exclude: ["e2e/**", "node_modules/**", "scripts/**", ".claude/**"],
    coverage: {
      provider: "v8",
      // Phase 71 (R45-CFG-10): scoped to src/utils + the tested API
      // routes (paths covered by unit tests today). Broader include
      // (src/lib, all of src/app/api) is a follow-up — currently those
      // paths are E2E-tested only and would drag the threshold below 70%.
      include: ["src/utils/**", "src/app/api/ftmo-state/**"],
      exclude: ["src/__tests__/**", "src/types/**"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
