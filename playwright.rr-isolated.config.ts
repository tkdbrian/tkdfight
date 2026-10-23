import { defineConfig, devices } from "@playwright/test";

const apiPort = 3397;
const webPort = 5197;
// Each test owns a fresh API process and TEMP database through isolated-test.ts.

export default defineConfig({
  testDir: "./e2e",
  testMatch: "round-robin-isolated.spec.ts",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "./test-results/round-robin-isolated",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${webPort}`,
    headless: true,
    actionTimeout: 10_000,
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}/`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ...process.env, API_PORT: String(apiPort) },
    },
  ],
});
