import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? `.playwright-test-results-${Date.now()}`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'node "./node_modules/next/dist/bin/next" build && node "./node_modules/next/dist/bin/next" start -p 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 180000,
  },
});
