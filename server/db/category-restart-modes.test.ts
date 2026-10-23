import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateEliminationBracket, generateGroupsTournament } from "../../src/lib/bracket";
import {
  type CategoryRestartSnapshot,
  categoryRestartSnapshotSchema,
} from "../../src/lib/category-restart-contract";
import type { CategoryDeleteAndRestartRequest } from "../../src/lib/category-restart-modes-contract";
import baselineRules from "../../src/rules/rules/rules_sparring_itf_baseline.json";

let database: typeof import("./index.js") | null = null;
let directory: string | null = null;
afterEach(() => {
  database?.default.close();
  if (directory) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(tmpdir()) ||
      !path.basename(target).startsWith("tkd-restart-modes-db-")
    )
      throw new Error("Unsafe temporary directory");
    rmSync(target, { recursive: true, force: true });
  }
  database = null;
  directory = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function setup(): Promise<typeof import("./index.js")> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-restart-modes-db-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  database = await import("./index.js");
  return database;
}
function graph(elimination = false): CategoryRestartSnapshot {
  const competitors = ["Uno", "Dos", "Tres"].map((name) => ({
    id: randomUUID(),
    name,
    team: "Club",
  }));
  const bracket = elimination
    ? generateEliminationBracket(competitors)
    : { matches: [], seeds: [] };
  return categoryRestartSnapshotSchema.parse({
    phase: "fighting",
    config: {
      id: randomUUID(),
      eventId: "event",
      tournamentName: "Evento",
      categoryName: "Prueba",
      tableChief: "Mesa",
      ruleSet: baselineRules,
      judgesCount: 3,
      mode: elimination ? "elimination" : "round-robin",
      matchType: "sparring",
      profileId: "yusan-2026",
      profileApplied: true,
    },
    competitors,
    ...(elimination ? { groups: [], fights: [] } : generateGroupsTournament(competitors)),
    currentFightIndex: 0,
    bracketMatches: bracket.matches,
    bracketSeeds: bracket.seeds,
    setupStarted: true,
  });
}
function register(db: typeof import("./index.js"), source: CategoryRestartSnapshot): number {
  const id = db.resolveCategoryTournament({
    categoryId: source.config.id,
    tournamentName: source.config.tournamentName,
    categoryName: source.config.categoryName,
  }).tournamentId;
  for (const entrant of source.competitors) db.upsertCompetitor({ ...entrant, tournament_id: id });
  for (const fight of source.fights)
    db.upsertFight({
      id: fight.id,
      red_id: fight.red.id,
      blue_id: fight.blue.id,
      tournament_id: id,
      group_id: fight.groupId,
    });
  return id;
}
function input(
  db: typeof import("./index.js"),
  source: CategoryRestartSnapshot
): CategoryDeleteAndRestartRequest {
  return {
    requestId: randomUUID(),
    expectedRevision: db.previewCategoryDeletion(source).revision,
    previousSnapshot: source,
    replacementSnapshot: graph(source.config.mode === "elimination"),
  };
}
function rows(db: typeof import("./index.js")): unknown {
  return Object.fromEntries(
    [
      "tournaments",
      "competitors",
      "fights",
      "match_results",
      "match_snapshot",
      "category_tournaments",
      "ring_selection",
      "category_execution_archives",
      "category_execution_deletions",
      "category_deletion_identities",
      "category_execution_deleted_restarts",
    ].map((table) => [table, db.default.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
  );
}

it("atomically deletes only current results and creates fresh RR without changing earlier archives or other category", async () => {
  const db = await setup();
  const older = graph();
  const source = graph();
  const archive = db.restartCategoryExecution({
    requestId: randomUUID(),
    categoryId: older.config.id,
    previousSnapshot: older,
    replacementSnapshot: source,
  });
  const sourceId = archive.archive.replacementTournamentId;
  const unrelated = graph();
  const unrelatedId = register(db, unrelated);
  db.setSelectedTournamentId(sourceId);
  const first = source.fights[0];
  db.confirmMatchResult({
    fightId: first.id,
    categoryId: source.config.id,
    tournamentId: sourceId,
    winner: "red",
    reason: "points",
    flagsRed: 3,
    flagsBlue: 0,
    warningsRed: 1,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
  });
  Object.assign(first, {
    completed: true,
    winner: "red",
    winReason: "points",
    flagsRed: 3,
    warningsRed: 1,
  });
  const archivesBefore = db.default.prepare("SELECT * FROM category_execution_archives").all();
  const unrelatedBefore = db.getFights(unrelatedId);
  const operation = input(db, source);
  const result = db.deleteAndRestartCategoryExecution(operation);
  expect(result).toMatchObject({
    ok: true,
    requestId: operation.requestId,
    categoryId: source.config.id,
    replacementCategoryId: operation.replacementSnapshot.config.id,
    replacementSnapshot: operation.replacementSnapshot,
    deletion: { tournamentId: sourceId, counts: { confirmedResults: 1, completedFights: 1 } },
  });
  const nextId = db.getCategoryTournamentId(result.replacementCategoryId);
  if (nextId === null) throw new Error("Replacement tournament is missing");
  expect(nextId).not.toBe(sourceId);
  expect(db.getFights(sourceId)).toEqual([]);
  expect(db.getCompetitors(sourceId)).toEqual([]);
  expect(db.default.prepare("SELECT * FROM match_results").all()).toEqual([]);
  expect(db.getFights(nextId)).toHaveLength(3);
  expect(
    db
      .getFights(nextId)
      .every(
        (fight) =>
          fight !== null &&
          typeof fight === "object" &&
          "completed" in fight &&
          fight.completed === 0
      )
  ).toBe(true);
  expect(db.getSelectedTournamentId()).toBe(nextId);
  expect(db.default.prepare("SELECT * FROM ring_selection").get()).toMatchObject({
    explicitly_cleared: 0,
  });
  expect(db.default.prepare("SELECT * FROM category_execution_archives").all()).toEqual(
    archivesBefore
  );
  expect(db.getFights(unrelatedId)).toEqual(unrelatedBefore);
  expect(() => db.getCategoryReplacement(older.config.id)).toThrowError(
    expect.objectContaining({ code: "replacement_deleted" })
  );
  expect(db.getCategoryDeleteAndRestart(source.config.id)).toEqual(result);
  expect(db.deleteAndRestartCategoryExecution(operation)).toEqual(result);
  expect(
    db.default.prepare("SELECT * FROM category_execution_deleted_restarts").all()
  ).toHaveLength(1);
});

it("supports local-only elimination byes without old SQL tournament and leaves unrelated selection intact", async () => {
  const db = await setup();
  const unrelated = graph();
  const unrelatedId = register(db, unrelated);
  db.setSelectedTournamentId(unrelatedId);
  const source = graph(true);
  const operation = input(db, source);
  const result = db.deleteAndRestartCategoryExecution(operation);
  expect(result.deletion.tournamentId).toBeNull();
  expect(result.replacementSnapshot.config.ruleSet).toEqual(baselineRules);
  expect(result.replacementSnapshot.bracketMatches.some((match) => match.completed)).toBe(true);
  expect(db.getSelectedTournamentId()).toBe(unrelatedId);
  expect(db.default.prepare("SELECT * FROM tournaments").all()).toHaveLength(2);
  expect(db.default.prepare("SELECT * FROM category_execution_archives").all()).toEqual([]);
  expect(db.default.prepare("SELECT * FROM match_results").all()).toEqual([]);
  expect(() => db.assertCompetitorWritable(source.competitors[0].id)).toThrowError(
    expect.objectContaining({ code: "category_deleted" })
  );
});

it("rolls back every SQL row, confirmed recovery and selection even if final combined receipt fails", async () => {
  const db = await setup();
  const source = graph();
  const id = register(db, source);
  db.setSelectedTournamentId(id);
  const fight = source.fights[0];
  db.confirmMatchResult({
    fightId: fight.id,
    categoryId: source.config.id,
    tournamentId: id,
    winner: "blue",
    reason: "points",
    flagsRed: 0,
    flagsBlue: 3,
    warningsRed: 0,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
  });
  Object.assign(fight, { completed: true, winner: "blue", flagsBlue: 3 });
  db.saveMatchSnapshot(fight.id, id, { match: {}, rules: {}, roundFlags: [] }, source.config.id);
  const operation = input(db, source);
  const before = rows(db);
  db.default.exec(
    "CREATE TRIGGER fail_combined BEFORE INSERT ON category_execution_deleted_restarts BEGIN SELECT RAISE(ABORT, 'late combined failure'); END"
  );
  expect(() => db.deleteAndRestartCategoryExecution(operation)).toThrow("late combined failure");
  expect(rows(db)).toEqual(before);
  db.default.exec("DROP TRIGGER fail_combined");
  const result = db.deleteAndRestartCategoryExecution(operation);
  expect(db.loadMatchSnapshot()).toBeNull();
  expect(result.deletion.counts.confirmedResults).toBe(1);
});

it("rechecks memory/durable locks, preview revision, exact ownership and fresh fixture without mutation", async () => {
  const db = await setup();
  const source = graph();
  const id = register(db, source);
  const operation = input(db, source);
  const before = rows(db);
  expect(() =>
    db.deleteAndRestartCategoryExecution(operation, { hasUnconfirmedMatch: true })
  ).toThrowError(expect.objectContaining({ code: "active_match" }));
  db.saveMatchSnapshot("other-pending", id, { match: {}, rules: {}, roundFlags: [] }, "other");
  expect(() => db.deleteAndRestartCategoryExecution(operation)).toThrowError(
    expect.objectContaining({ code: "active_match" })
  );
  db.clearMatchSnapshot();
  expect(() =>
    db.deleteAndRestartCategoryExecution({ ...operation, expectedRevision: "f".repeat(64) })
  ).toThrowError(expect.objectContaining({ code: "snapshot_conflict" }));
  const badFixture = structuredClone(operation);
  badFixture.replacementSnapshot.fights[0].completed = true;
  expect(() => db.deleteAndRestartCategoryExecution(badFixture)).toThrowError(
    expect.objectContaining({ code: "snapshot_conflict" })
  );
  db.upsertFight({
    id: randomUUID(),
    tournament_id: id,
    red_id: source.competitors[0].id,
    blue_id: source.competitors[1].id,
  });
  const ambiguousBefore = rows(db);
  expect(() => db.deleteAndRestartCategoryExecution(operation)).toThrowError(
    expect.objectContaining({ code: "deletion_scope_ambiguous" })
  );
  expect(rows(db)).toEqual(ambiguousBefore);
  expect(db.getCategoryDeletion(source.config.id)).toBeNull();
  expect(before).not.toEqual(ambiguousBefore);
});

it("rejects request-ID reuse across delete-only, archive and destructive restart modes", async () => {
  const db = await setup();
  const source = graph();
  register(db, source);
  const operation = input(db, source);
  db.deleteAndRestartCategoryExecution(operation);
  const before = rows(db);
  expect(() =>
    db.deleteCategoryExecution({
      requestId: operation.requestId,
      expectedRevision: operation.expectedRevision,
      localSnapshot: source,
    })
  ).toThrowError(expect.objectContaining({ code: "request_id_conflict" }));
  const other = graph();
  expect(() =>
    db.restartCategoryExecution({
      requestId: operation.requestId,
      categoryId: other.config.id,
      previousSnapshot: other,
      replacementSnapshot: graph(),
    })
  ).toThrowError(expect.objectContaining({ code: "request_id_conflict" }));
  expect(rows(db)).toEqual(before);
  const archivedSource = graph();
  const archiveRequest = {
    requestId: randomUUID(),
    categoryId: archivedSource.config.id,
    previousSnapshot: archivedSource,
    replacementSnapshot: graph(),
  };
  db.restartCategoryExecution(archiveRequest);
  const third = graph();
  const thirdRequest = input(db, third);
  const beforeThird = rows(db);
  expect(() =>
    db.deleteAndRestartCategoryExecution({ ...thirdRequest, requestId: archiveRequest.requestId })
  ).toThrowError(expect.objectContaining({ code: "request_id_conflict" }));
  expect(rows(db)).toEqual(beforeThird);
  expect(() =>
    db.deleteAndRestartCategoryExecution({ ...operation, expectedRevision: "b".repeat(64) })
  ).toThrowError(expect.objectContaining({ code: "request_id_conflict" }));
});

it("returns original commit proof without initial snapshot when its replacement was later archived", async () => {
  const db = await setup();
  const source = graph();
  const operation = input(db, source);
  const committed = db.deleteAndRestartCategoryExecution(operation);
  const next = graph();
  db.restartCategoryExecution({
    requestId: randomUUID(),
    categoryId: committed.replacementCategoryId,
    previousSnapshot: operation.replacementSnapshot,
    replacementSnapshot: next,
  });
  const before = rows(db);
  for (const read of [
    () => db.getCategoryDeleteAndRestart(source.config.id),
    () => db.deleteAndRestartCategoryExecution(operation),
  ]) {
    expect(read).toThrowError(
      expect.objectContaining({
        response: {
          ok: false,
          error: "category_archived",
          message: expect.any(String),
          categoryId: source.config.id,
          requestId: operation.requestId,
          deletion: committed.deletion,
          archivedCategoryId: committed.replacementCategoryId,
          replacementCategoryId: next.config.id,
        },
      })
    );
  }
  expect(rows(db)).toEqual(before);
});

it.each([
  false,
  true,
])("never rehydrates deleted replacement (through archive link=%s)", async (viaArchive) => {
  const db = await setup();
  const source = graph();
  const operation = input(db, source);
  const committed = db.deleteAndRestartCategoryExecution(operation);
  const terminal = viaArchive ? graph() : operation.replacementSnapshot;
  if (viaArchive)
    db.restartCategoryExecution({
      requestId: randomUUID(),
      categoryId: committed.replacementCategoryId,
      previousSnapshot: operation.replacementSnapshot,
      replacementSnapshot: terminal,
    });
  const deletion = db.deleteCategoryExecution({
    requestId: randomUUID(),
    expectedRevision: db.previewCategoryDeletion(terminal).revision,
    localSnapshot: terminal,
  });
  const before = rows(db);
  for (const read of [
    () => db.getCategoryDeleteAndRestart(source.config.id),
    () => db.deleteAndRestartCategoryExecution(operation),
  ]) {
    expect(read).toThrowError(
      expect.objectContaining({
        response: {
          ok: false,
          error: "replacement_deleted",
          message: expect.any(String),
          categoryId: source.config.id,
          requestId: operation.requestId,
          deletion: committed.deletion,
          replacementCategoryId: committed.replacementCategoryId,
          replacementDeletion: deletion,
        },
      })
    );
  }
  expect(rows(db)).toEqual(before);
});

it.each([
  "delete",
  "archive",
])("rejects a retired bracket-only UUID before %s restart of an unrelated source", async (mode) => {
  const db = await setup();
  const deleted = graph(true);
  db.deleteCategoryExecution({
    requestId: randomUUID(),
    expectedRevision: db.previewCategoryDeletion(deleted).revision,
    localSnapshot: deleted,
  });
  const source = graph(true);
  const operation = input(db, source);
  const retiredId = deleted.bracketMatches[0].id;
  const originalId = operation.replacementSnapshot.bracketMatches[0].id;
  for (const match of operation.replacementSnapshot.bracketMatches) {
    if (match.id === originalId) match.id = retiredId;
    for (const slot of [match.red, match.blue]) {
      if (slot.fromMatchId === originalId) slot.fromMatchId = retiredId;
    }
  }
  const before = rows(db);
  const restart = () =>
    mode === "delete"
      ? db.deleteAndRestartCategoryExecution(operation)
      : db.restartCategoryExecution({
          requestId: operation.requestId,
          categoryId: source.config.id,
          previousSnapshot: operation.previousSnapshot,
          replacementSnapshot: operation.replacementSnapshot,
        });
  expect(restart).toThrowError(expect.objectContaining({ code: "category_deleted" }));
  expect(rows(db)).toEqual(before);
});
