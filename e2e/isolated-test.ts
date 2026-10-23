import { test as base } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import setup from "./rr-isolated-setup";

// A fresh browser must be paired with a fresh SQL database. full-reset deliberately
// preserves profile/history metadata and is not a test database reset mechanism.
export const test = base.extend<{ isolatedApi: void }>({
  isolatedApi: [async ({}, use) => {
    process.env.RR_E2E_DATA_DIR = join(tmpdir(), `tkd-rr-e2e-${randomUUID()}`);
    const stop = await setup();
    try { await use(); } finally { await stop(); }
  }, { auto: true }],
});
