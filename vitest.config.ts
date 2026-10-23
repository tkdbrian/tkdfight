import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    exclude: [
      "**/node_modules/**", "**/dist/**", "**/e2e/**",
      // Local releases and old portable copies are not repository test sources.
      "release/**", "preview-*/**", "TKD_Fight_*/**", "TKD_Torneo_*/**", "dist-produccion*/**",
    ],
  },
});
