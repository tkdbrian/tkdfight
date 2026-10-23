import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiPort = 3317;
const webPort = 5174;
const dataDir = mkdtempSync(join(tmpdir(), "tkd-stage3-playwright-"));
console.info(`[stage3] Isolated DATA_DIR: ${dataDir}`);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "categories-stage3.spec.ts",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "./test-results/categories-stage3",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npx tsx server/index.ts",
      port: apiPort,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ...process.env, PORT: String(apiPort), DATA_DIR: dataDir },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}/`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ...process.env, API_PORT: String(apiPort) },
    },
  ],
});
