import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

/** Isolated Vite-only demo test: no SQL server and no real tournament data. */
export default defineConfig({
  testDir: resolve(process.cwd(), "e2e"),
  testMatch: "demo-setup-visual.spec.ts",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:8770", headless: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 8770 --strictPort",
    cwd: process.cwd(),
    url: "http://127.0.0.1:8770/demo/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
