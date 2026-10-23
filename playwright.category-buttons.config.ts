import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
export default defineConfig({
  testDir: "./e2e", testMatch: "category-buttons-audit.spec.ts", timeout: 60_000,
  retries: 0, workers: 1, reporter: "list",
  outputDir: join(tmpdir(), "tkd-category-buttons-results"),
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5174", headless: true,
    actionTimeout: 10_000, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174/", reuseExistingServer: false, timeout: 30_000,
    env: { ...process.env, API_PORT: "3317" } },
});
