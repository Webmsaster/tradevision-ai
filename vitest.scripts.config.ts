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
    // R67-r9: type-cast around vitest 4.x stricter PoolOptions surface
    // (the `forks` key is correct at runtime per docs, but the InlineConfig
    // type doesn't yet include the discriminated PoolOptions union).
    ...({ poolOptions: { forks: { singleFork: true } } } as Record<
      string,
      unknown
    >),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
