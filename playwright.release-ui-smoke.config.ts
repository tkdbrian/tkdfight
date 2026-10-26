import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The isolated-test fixture starts a fresh SQL API on :3397 for each test.
// Never use the default Playwright config, which can target a live tournament.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "release-ui-smoke.spec.ts",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: join(tmpdir(), "tkd-release-ui-smoke-results"),
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5197",
    headless: true,
    actionTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5197 --strictPort",
    url: "http://127.0.0.1:5197/",
    reuseExistingServer: false,
    timeout: 30_000,
    env: { ...process.env, API_PORT: "3397" },
  },
});
