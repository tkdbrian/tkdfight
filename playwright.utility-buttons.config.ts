import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import base from "./playwright.fight-buttons.config";
export default defineConfig({ ...base, testMatch: "utility-buttons-audit.spec.ts", timeout: 120_000,
  outputDir: join(tmpdir(), "tkd-utility-buttons-results") });
