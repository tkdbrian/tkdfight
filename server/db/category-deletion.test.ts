import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateEliminationBracket, generateGroupsTournament } from "../../src/lib/bracket";
import type { CategoryRestartSnapshot } from "../../src/lib/category-restart-contract";

let db: typeof import("./index.js") | null = null;
let directory: string | null = null;
afterEach(() => {
  db?.default.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  db = null;
  directory = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function setup(): Promise<typeof import("./index.js")> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-delete-db-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  db = await import("./index.js");
  return db;
}
function graph(elimination = false): CategoryRestartSnapshot {
  const competitors = ["Uno", "Dos", "Tres"].map((name) => ({ id: randomUUID(), name }));
  const bracket = elimination
    ? generateEliminationBracket(competitors)
    : { matches: [], seeds: [] };
  const fixture = elimination ? { groups: [], fights: [] } : generateGroupsTournament(competitors);
  return {
    phase: "fighting",
    config: {
      id: randomUUID(),
      eventId: "event",
      tournamentName: "Evento",
      categoryName: "Prueba",
      tableChief: "Mesa",
      ruleSet: null,
      judgesCount: 3,
      mode: elimination ? "elimination" : "round-robin",
      matchType: "sparring",
    },
    competitors,
    ...fixture,
    currentFightIndex: 0,
    bracketMatches: bracket.matches,
    bracketSeeds: bracket.seeds,
    setupStarted: true,
  };
}
function register(
  database: typeof import("./index.js"),
  snapshot: CategoryRestartSnapshot
): number {
  const { tournamentId } = database.resolveCategoryTournament({
    categoryId: snapshot.config.id,
    tournamentName: snapshot.config.tournamentName,
    categoryName: snapshot.config.categoryName,
  });
  for (const competitor of snapshot.competitors)
    database.upsertCompetitor({ ...competitor, tournament_id: tournamentId });
  for (const fight of snapshot.fights)
    database.insertFightIfNew({
      id: fight.id,
      tournament_id: tournamentId,
      red_id: fight.red.id,
      blue_id: fight.blue.id,
    });
  return tournamentId;
}
function request(database: typeof import("./index.js"), localSnapshot: CategoryRestartSnapshot) {
  return {
    requestId: randomUUID(),
    expectedRevision: database.previewCategoryDeletion(localSnapshot).revision,
    localSnapshot,
  };
}

it("deletes exact current rows, preserves earlier archive bytes and same-name other category, and never resurrects receipt", async () => {
  const database = await setup();
  const old = graph();
  const oldId = register(database, old);
  const replacement = graph();
  const restart = {
    requestId: randomUUID(),
    categoryId: old.config.id,
    previousSnapshot: old,
    replacementSnapshot: replacement,
  };
  const archived = database.restartCategoryExecution(restart);
  const other = graph();
  const otherId = register(database, other);
  database.setSelectedTournamentId(archived.archive.replacementTournamentId);
  const archiveBytes = database.default.prepare("SELECT * FROM category_execution_archives").all();
  const otherBytes = database.getFights(otherId);
  const preview = database.previewCategoryDeletion(replacement);
  expect(preview).toMatchObject({
    ok: true,
    categoryId: replacement.config.id,
    counts: {
      competitors: 3,
      fights: 3,
      completedFights: 0,
      confirmedResults: 0,
      localOnlyFights: 0,
    },
    requiresConfirmationText: true,
  });
  const input = {
    requestId: randomUUID(),
    expectedRevision: preview.revision,
    localSnapshot: replacement,
  };
  const receipt = database.deleteCategoryExecution(input);
  expect(receipt).toMatchObject({
    ok: true,
    requestId: input.requestId,
    categoryId: replacement.config.id,
    tournamentId: archived.archive.replacementTournamentId,
    counts: preview.counts,
  });
  expect(database.getFights(archived.archive.replacementTournamentId)).toEqual([]);
  expect(database.getCompetitors(archived.archive.replacementTournamentId)).toEqual([]);
  expect(database.default.prepare("SELECT * FROM category_execution_archives").all()).toEqual(
    archiveBytes
  );
  expect(database.getFights(oldId)).toHaveLength(3);
  expect(database.getFights(otherId)).toEqual(otherBytes);
  expect(database.getSelectedTournamentId()).toBeNull();
  expect(database.getStartupTournamentId()).toBeNull();
  expect(database.getTournament(archived.archive.replacementTournamentId)).toMatchObject({
    name: "",
    category: "",
  });
  expect(database.deleteCategoryExecution(input)).toEqual(receipt);
  expect(database.getCategoryDeletion(replacement.config.id)).toEqual(receipt);
  expect(() =>
    database.deleteCategoryExecution({ ...input, expectedRevision: "f".repeat(64) })
  ).toThrowError(expect.objectContaining({ code: "request_id_conflict" }));
  expect(() => database.getCategoryReplacement(old.config.id)).toThrowError(
    expect.objectContaining({
      code: "replacement_deleted",
      categoryId: old.config.id,
      deletion: receipt,
    })
  );
  expect(() => database.restartCategoryExecution(restart)).toThrowError(
    expect.objectContaining({ code: "replacement_deleted", deletion: receipt })
  );
});

it("handles empty local draft and elimination byes without fabricating SQL tournaments or results", async () => {
  const database = await setup();
  const empty = graph();
  Object.assign(empty, {
    phase: "setup",
    competitors: [],
    fights: [],
    groups: [],
    bracketMatches: [],
    bracketSeeds: [],
  });
  expect(database.previewCategoryDeletion(empty)).toMatchObject({
    requiresConfirmationText: false,
    counts: { fights: 0, confirmedResults: 0 },
  });
  expect(database.deleteCategoryExecution(request(database, empty)).tournamentId).toBeNull();
  const elimination = graph(true);
  const preview = database.previewCategoryDeletion(elimination);
  expect(preview.requiresConfirmationText).toBe(true);
  expect(preview.counts).toMatchObject({ competitors: 3, fights: 0, completedFights: 0 });
  database.deleteCategoryExecution(request(database, elimination));
  expect(database.default.prepare("SELECT * FROM tournaments").all()).toEqual([]);
  expect(database.default.prepare("SELECT * FROM match_results").all()).toEqual([]);
  expect(database.getCategoryDeletionTombstones()).toHaveLength(2);
});

it("blocks ambiguous SQL extras, foreign owners and shared cross-references before writes", async () => {
  const database = await setup();
  const current = graph();
  const currentId = register(database, current);
  const other = graph();
  const otherId = register(database, other);
  const fight = current.fights[0];
  database.upsertFight({
    id: "unlinked-old-run",
    tournament_id: currentId,
    red_id: fight.red.id,
    blue_id: fight.blue.id,
  });
  expect(() => database.previewCategoryDeletion(current)).toThrowError(
    expect.objectContaining({ code: "deletion_scope_ambiguous" })
  );
  database.default.prepare("DELETE FROM fights WHERE id = ?").run("unlinked-old-run");
  database.default
    .prepare("UPDATE fights SET red_id = ? WHERE id = ?")
    .run(current.competitors[0].id, other.fights[0].id);
  expect(() => database.previewCategoryDeletion(current)).toThrowError(
    expect.objectContaining({ code: "deletion_scope_ambiguous" })
  );
  database.default
    .prepare("UPDATE fights SET red_id = ? WHERE id = ?")
    .run(other.fights[0].red.id, other.fights[0].id);
  const alien = structuredClone(current);
  alien.competitors.push(other.competitors[0]);
  expect(() => database.previewCategoryDeletion(alien)).toThrowError(
    expect.objectContaining({ code: "deletion_scope_ambiguous" })
  );
  const result = {
    fightId: fight.id,
    categoryId: current.config.id,
    tournamentId: currentId,
    winner: "red" as const,
    reason: "points",
    flagsRed: 3,
    flagsBlue: 0,
    warningsRed: 0,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
  };
  database.confirmMatchResult(result);
  database.default
    .prepare("UPDATE match_results SET category_id = ?, tournament_id = ? WHERE fight_id = ?")
    .run(other.config.id, otherId, fight.id);
  expect(() => database.previewCategoryDeletion(current)).toThrowError(
    expect.objectContaining({ code: "deletion_scope_ambiguous" })
  );
  expect(database.getFights(currentId)).toHaveLength(3);
  expect(database.getCategoryDeletion(current.config.id)).toBeNull();
});

it("rechecks revision and global memory/durable locks; injected late failure preserves every row and selection", async () => {
  const database = await setup();
  const current = graph();
  const currentId = register(database, current);
  database.setSelectedTournamentId(currentId);
  const input = request(database, current);
  expect(() => database.deleteCategoryExecution(input, { hasUnconfirmedMatch: true })).toThrowError(
    expect.objectContaining({ code: "active_match" })
  );
  database.saveMatchSnapshot("legacy-other", 99, { match: {}, rules: {}, roundFlags: [] });
  expect(() => database.deleteCategoryExecution(input)).toThrowError(
    expect.objectContaining({ code: "active_match" })
  );
  database.clearMatchSnapshot();
  database.default
    .prepare("UPDATE competitors SET name = ? WHERE id = ?")
    .run("Changed", current.competitors[0].id);
  expect(() => database.deleteCategoryExecution(input)).toThrowError(
    expect.objectContaining({ code: "snapshot_conflict" })
  );
  database.default
    .prepare("UPDATE competitors SET name = ? WHERE id = ?")
    .run(current.competitors[0].name, current.competitors[0].id);
  const before = database.default.prepare("SELECT * FROM fights").all();
  database.default.exec(
    "CREATE TRIGGER fail_delete BEFORE INSERT ON category_execution_deletions BEGIN SELECT RAISE(ABORT, 'late delete failure'); END"
  );
  expect(() => database.deleteCategoryExecution(input)).toThrow("late delete failure");
  expect(database.default.prepare("SELECT * FROM fights").all()).toEqual(before);
  expect(database.getSelectedTournamentId()).toBe(currentId);
  expect(database.getCategoryDeletion(current.config.id)).toBeNull();
});

it("reserves deleted identities across SQL/legacy write helpers without freezing unrelated UUIDs", async () => {
  const database = await setup();
  const current = graph();
  const currentId = register(database, current);
  const other = graph();
  const otherId = register(database, other);
  const fight = current.fights[0];
  const receipt = database.deleteCategoryExecution(request(database, current));
  const actions = [
    () =>
      database.resolveCategoryTournament({
        categoryId: current.config.id,
        categoryName: "X",
        tournamentName: "X",
      }),
    () => database.renameTournament(currentId, "X", "X"),
    () => database.setSelectedTournamentId(currentId),
    () => database.clearTournamentData(currentId),
    () => database.upsertCompetitor({ ...current.competitors[0], tournament_id: otherId }),
    () =>
      database.upsertFight({
        id: fight.id,
        tournament_id: otherId,
        red_id: other.competitors[0].id,
        blue_id: other.competitors[1].id,
      }),
    () => database.completeFight(fight.id, "red", "points"),
    () =>
      database.saveMatchSnapshot(
        fight.id,
        otherId,
        { match: {}, rules: {}, roundFlags: [] },
        other.config.id
      ),
  ];
  for (const action of actions)
    expect(action).toThrowError(
      expect.objectContaining({ code: "category_deleted", deletion: receipt })
    );
  expect(() =>
    database.upsertCompetitor({ ...other.competitors[0], tournament_id: otherId })
  ).not.toThrow();
});

it("finds terminal deletion through multiple immutable restart links without changing any archive", async () => {
  const database = await setup();
  const a = graph();
  register(database, a);
  const b = graph();
  const c = graph();
  const first = {
    requestId: randomUUID(),
    categoryId: a.config.id,
    previousSnapshot: a,
    replacementSnapshot: b,
  };
  database.restartCategoryExecution(first);
  database.restartCategoryExecution({
    requestId: randomUUID(),
    categoryId: b.config.id,
    previousSnapshot: b,
    replacementSnapshot: c,
  });
  const before = database.default.prepare("SELECT * FROM category_execution_archives").all();
  const receipt = database.deleteCategoryExecution(request(database, c));
  expect(database.getDeletedCategoryReplacement(a.config.id)).toEqual(receipt);
  expect(() => database.getCategoryReplacement(a.config.id)).toThrowError(
    expect.objectContaining({
      code: "replacement_deleted",
      categoryId: a.config.id,
      deletion: receipt,
    })
  );
  expect(() => database.restartCategoryExecution(first)).toThrowError(
    expect.objectContaining({ code: "replacement_deleted", categoryId: a.config.id })
  );
  expect(database.default.prepare("SELECT * FROM category_execution_archives").all()).toEqual(
    before
  );
  expect(database.getStartupTournamentId()).toBeNull();
});

it("preserves unrelated selection and persists explicit deselection across DB reopen until explicit activation", async () => {
  let database = await setup();
  const a = graph();
  const aId = register(database, a);
  const b = graph();
  register(database, b);
  database.setSelectedTournamentId(aId);
  database.deleteCategoryExecution(request(database, b));
  expect(database.getSelectedTournamentId()).toBe(aId);
  expect(database.getStartupTournamentId()).toBe(aId);
  expect(database.getRetiredIdleTournamentId()).toBeNull();
  database.deleteCategoryExecution(request(database, a));
  const before = database.default.prepare("SELECT * FROM tournaments ORDER BY id").all();
  expect(database.getSelectedTournamentId()).toBeNull();
  database.default.close();
  vi.resetModules();
  database = await import("./index.js");
  db = database;
  expect(database.getStartupTournamentId()).toBeNull();
  expect(database.getRetiredIdleTournamentId()).not.toBeNull();
  expect(database.default.prepare("SELECT * FROM tournaments ORDER BY id").all()).toEqual(before);
  const fresh = graph();
  const next = database.resolveCategoryTournament({
    categoryId: fresh.config.id,
    tournamentName: fresh.config.tournamentName,
    categoryName: fresh.config.categoryName,
    preferredTournamentId: aId,
  });
  expect(next.tournamentId).not.toBe(aId);
  database.setSelectedTournamentId(next.tournamentId);
  expect(database.getStartupTournamentId()).toBe(next.tournamentId);
  expect(database.getRetiredIdleTournamentId()).toBeNull();
});

it("does not equate an existing NULL legacy SQL owner with an unregistered local execution", async () => {
  const database = await setup();
  const local = graph();
  const insert = database.default.prepare(
    "INSERT INTO competitors (id, tournament_id, name) VALUES (?, NULL, ?)"
  );
  for (const competitor of local.competitors) insert.run(competitor.id, competitor.name);
  const before = database.default.prepare("SELECT * FROM competitors ORDER BY id").all();
  expect(() => database.previewCategoryDeletion(local)).toThrowError(
    expect.objectContaining({ code: "deletion_scope_ambiguous" })
  );
  const fight = local.fights[0];
  database.default
    .prepare("INSERT INTO fights (id, tournament_id, red_id, blue_id) VALUES (?, NULL, ?, ?)")
    .run(fight.id, fight.red.id, fight.blue.id);
  expect(() => database.previewCategoryDeletion(local)).toThrowError(
    expect.objectContaining({ code: "deletion_scope_ambiguous" })
  );
  expect(database.default.prepare("SELECT * FROM competitors ORDER BY id").all()).toEqual(before);
  expect(database.getCategoryDeletion(local.config.id)).toBeNull();
  database.default.prepare("DELETE FROM fights WHERE id = ?").run(fight.id);
  for (const competitor of local.competitors)
    database.default.prepare("DELETE FROM competitors WHERE id = ?").run(competitor.id);
  expect(database.previewCategoryDeletion(local)).toMatchObject({
    counts: { competitors: 3, localOnlyFights: 3 },
  });
  expect(database.deleteCategoryExecution(request(database, local)).tournamentId).toBeNull();
});
