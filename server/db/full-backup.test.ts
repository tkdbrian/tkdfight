import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

let directory: string | null = null;
let database: typeof import("./index.js") | null = null;
afterEach(() => {
  database?.default.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  database = null;
  directory = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function setup() {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-backup-db-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  database = await import("./index.js");
  const backup = await import("./full-backup.js");
  return { database, backup };
}

it("captures only explicit application tables and preserves IDs and sequences", async () => {
  const { database, backup } = await setup();
  database.default
    .prepare("INSERT INTO tournaments (id, name, category) VALUES (7, 'Event', '')")
    .run();
  const snapshot = backup.captureSqlBackup();
  expect(Object.keys(snapshot.tables)).toContain("category_elimination_continuations");
  expect(Object.keys(snapshot.tables)).not.toContain("restore_receipts");
  expect(snapshot.tables.tournaments).toMatchObject([{ id: 7, name: "Event" }]);
  expect(snapshot.sequences.tournaments).toBe(7);
});

it("rejects a nonempty target without altering it", async () => {
  const { database, backup } = await setup();
  database.default.prepare("INSERT INTO competitors (id, name) VALUES ('owned', 'Owner')").run();
  const snapshot = backup.captureSqlBackup();
  expect(() => backup.restoreSqlBackup(snapshot, "id", "hash", "browser-hash")).toThrow();
  expect(database.default.prepare("SELECT name FROM competitors WHERE id='owned'").get()).toEqual({
    name: "Owner",
  });
});

it("rejects malformed table rows before SQL commit", async () => {
  const { database, backup } = await setup();
  const snapshot = backup.captureSqlBackup();
  snapshot.tables.tournaments.push({ id: 9, evil: "no" });
  expect(() => backup.restoreSqlBackup(snapshot, "id", "hash", "browser-hash")).toThrow();
  expect(database.default.prepare("SELECT COUNT(*) AS count FROM restore_receipts").get()).toEqual({
    count: 0,
  });
});

it("restores an isolated database with foreign keys, source identities, sequence and durable receipt", async () => {
  const source = await setup();
  source.database.default
    .prepare("INSERT INTO tournaments (id, name, category) VALUES (7, 'Event', '')")
    .run();
  source.database.default
    .prepare("INSERT INTO tournaments (id, name, category) VALUES (8, 'Replacement', '')")
    .run();
  source.database.default
    .prepare("INSERT INTO tournaments (id, name, category) VALUES (9, 'Deleted', '')")
    .run();
  source.database.default
    .prepare("INSERT INTO competitors (id, tournament_id, name) VALUES ('c1', 7, 'Player')")
    .run();
  source.database.default
    .prepare("INSERT INTO competitors (id, tournament_id, name) VALUES ('c2', 7, 'Other')")
    .run();
  source.database.default
    .prepare("INSERT INTO category_tournaments (category_id, tournament_id) VALUES ('cat1', 7)")
    .run();
  source.database.default
    .prepare("INSERT INTO category_tournaments (category_id, tournament_id) VALUES ('cat2', 8)")
    .run();
  source.database.default
    .prepare("INSERT INTO fights (id, tournament_id, red_id, blue_id) VALUES ('f1', 7, 'c1', 'c2')")
    .run();
  source.database.default
    .prepare("INSERT INTO fights (id, tournament_id, red_id, blue_id) VALUES ('f2', 7, 'c1', 'c2')")
    .run();
  source.database.default
    .prepare(`INSERT INTO category_elimination_continuations
    (category_id,parent_fight_id,parent_revision,stage,canonical_fight_id,red_id,blue_id)
    VALUES ('cat1','f1',0,'golden-point','f2','c1','c2')`)
    .run();
  source.database.default
    .prepare(`INSERT INTO category_execution_archives
    (category_id,request_id,replacement_category_id,source_tournament_id,replacement_tournament_id,
    archived_at,previous_snapshot,replacement_snapshot,warnings,request_fingerprint)
    VALUES ('cat1','req-archive','cat2',7,8,'2026-10-23','{}','{}','[]','fp')`)
    .run();
  source.database.default
    .prepare(`INSERT INTO category_execution_deletions
    (category_id,request_id,tournament_id,deleted_at,counts,request_fingerprint)
    VALUES ('cat3','req-delete',9,'2026-10-23','{}','fp')`)
    .run();
  source.database.default
    .prepare(`INSERT INTO category_deletion_identities
    (kind,identity_id,category_id) VALUES ('fight','gone-fight','cat3')`)
    .run();
  source.database.default
    .prepare(`INSERT INTO category_execution_deleted_restarts
    (category_id,request_id,replacement_category_id,replacement_snapshot,request_fingerprint,mode)
    VALUES ('cat3','req-delete','cat2','{}','fp','delete-and-restart')`)
    .run();
  const snapshot = source.backup.captureSqlBackup();
  source.database.default.close();
  database = null;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  const target = await setup();
  const invalid = structuredClone(snapshot);
  invalid.tables.competitors[0].tournament_id = 999;
  expect(() => target.backup.restoreSqlBackup(invalid, "bad", "bad", "bad")).toThrow();
  expect(
    target.database.default.prepare("SELECT COUNT(*) AS count FROM tournaments").get()
  ).toEqual({ count: 0 });
  expect(target.backup.getRestoreReceipt()).toBeNull();
  target.backup.restoreSqlBackup(snapshot, "backup-1", "payload-hash", "browser-hash");
  expect(
    target.database.default
      .prepare("SELECT tournament_id, name FROM competitors WHERE id='c1'")
      .get()
  ).toEqual({ tournament_id: 7, name: "Player" });
  expect(
    target.database.default
      .prepare("SELECT seq FROM sqlite_sequence WHERE name='tournaments'")
      .get()
  ).toEqual({ seq: 9 });
  expect(
    target.database.default
      .prepare("SELECT COUNT(*) AS n FROM category_elimination_continuations")
      .get()
  ).toEqual({ n: 1 });
  expect(
    target.database.default.prepare("SELECT COUNT(*) AS n FROM category_execution_archives").get()
  ).toEqual({ n: 1 });
  expect(
    target.database.default.prepare("SELECT COUNT(*) AS n FROM category_deletion_identities").get()
  ).toEqual({ n: 1 });
  expect(target.backup.getRestoreReceipt()?.status).toBe("pending");
  target.database.default.close();
  database = null;
  vi.resetModules();
  database = await import("./index.js");
  const restarted = await import("./full-backup.js");
  expect(restarted.getRestoreReceipt()?.status).toBe("pending");
  restarted.completeSqlRestore("backup-1", "payload-hash", "browser-hash");
  expect(restarted.getRestoreReceipt()?.status).toBe("complete");
  expect(() =>
    restarted.restoreSqlBackup(snapshot, "backup-2", "different", "different")
  ).toThrow();
});

it("rolls back the entire restore and receipt when SQLite runs out of pages", async () => {
  const source = await setup();
  source.database.default
    .prepare("INSERT INTO tournaments (name, category) VALUES (?, '')")
    .run("large-" + "x".repeat(200_000));
  const snapshot = source.backup.captureSqlBackup();
  source.database.default.close();
  database = null;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  const target = await setup();
  const pages = target.database.default.pragma("page_count", { simple: true }) as number;
  target.database.default.pragma(`max_page_count = ${pages}`);
  expect(() => target.backup.restoreSqlBackup(snapshot, "quota", "payload", "browser")).toThrow();
  expect(target.database.default.prepare("SELECT COUNT(*) AS n FROM tournaments").get()).toEqual({
    n: 0,
  });
  expect(target.backup.getRestoreReceipt()).toBeNull();
});
