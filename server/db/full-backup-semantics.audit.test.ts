// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("rejects a completed value outside 0/1 instead of making a restored fight disappear", async () => {
  const sourceDir = mkdtempSync(path.join(tmpdir(), "tkd-backup-audit-source-"));
  directories.push(sourceDir);
  vi.stubEnv("DATA_DIR", sourceDir);
  vi.resetModules();
  const sourceDb = (await import("./index.js")).default;
  const sourceBackup = await import("./full-backup.js");
  sourceDb.prepare("INSERT INTO tournaments (id, name, category) VALUES (7, 'Event', '')").run();
  sourceDb
    .prepare("INSERT INTO competitors (id, tournament_id, name) VALUES ('red', 7, 'Red')")
    .run();
  sourceDb
    .prepare("INSERT INTO competitors (id, tournament_id, name) VALUES ('blue', 7, 'Blue')")
    .run();
  sourceDb
    .prepare("INSERT INTO fights (id, tournament_id, red_id, blue_id) VALUES ('f1', 7, 'red', 'blue')")
    .run();
  const snapshot = sourceBackup.captureSqlBackup();
  sourceDb.close();

  snapshot.tables.fights[0].completed = 2;
  const targetDir = mkdtempSync(path.join(tmpdir(), "tkd-backup-audit-target-"));
  directories.push(targetDir);
  vi.stubEnv("DATA_DIR", targetDir);
  vi.resetModules();
  const targetDb = (await import("./index.js")).default;
  const targetBackup = await import("./full-backup.js");
  try {
    expect(() => targetBackup.restoreSqlBackup(snapshot, "id", "hash", "browser-hash")).toThrow();
    expect(targetDb.prepare("SELECT COUNT(*) AS n FROM fights").get()).toEqual({ n: 0 });
    expect(targetBackup.getRestoreReceipt()).toBeNull();
  } finally {
    targetDb.close();
  }
});
