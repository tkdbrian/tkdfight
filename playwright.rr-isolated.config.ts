import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const apiPort = 3397;
const webPort = 5197;
// Do not create a directory merely by importing this config (e.g. --list).
const dataDir = join(tmpdir(), `tkd-rr-e2e-${randomUUID()}`);
process.env.RR_E2E_DATA_DIR = dataDir;
console.info(`[round-robin] Isolated DATA_DIR: ${dataDir}`);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "round-robin-isolated.spec.ts",
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "./test-results/round-robin-isolated",
  globalSetup: "./e2e/rr-isolated-setup.ts",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${webPort}`,
    headless: true,
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
