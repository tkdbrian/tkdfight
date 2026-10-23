import { defineConfig } from "@playwright/test";

const apiPort = 3397;
const webPort = 5174;

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
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}/`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ...process.env, API_PORT: String(apiPort) },
    },
  ],
});
