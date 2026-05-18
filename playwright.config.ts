import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config for TKD Tournament System.
 *
 * Tests run against already-running servers:
 *   T1: http://localhost:3001  (Mesa Central + FightPage)
 *   T2: http://localhost:3002  (tatami de prueba con peleas cargadas)
 *
 * Start servers manually before running tests:
 *   $env:PORT="3001"; $env:DATA_DIR="./data-t1"; npx tsx server/index.ts
 *   $env:PORT="3002"; $env:DATA_DIR="./data-t2"; npx tsx server/index.ts
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 15_000,
  retries: 1,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://localhost:3001",
    headless: true,
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      process.platform === "win32"
        ? "cmd /c \"set PORT=3002 && set DATA_DIR=./data-t2 && npx tsx server/index.ts\""
        : "PORT=3002 DATA_DIR=./data-t2 npx tsx server/index.ts",
    port: 3002,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  // Vitest already excludes e2e/ — no conflict between test suites
  outputDir: "test-results/",
});
